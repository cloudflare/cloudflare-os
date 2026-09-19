import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { RpcStub } from "capnweb";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiChatSubscriber,
  ChatCodeBase, ChatGadgetPin, Overseer, WorkpieceSummary,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeChange, type CodeContent, type FileChange }
  from "@gadgets/workshop-shared/code-change";
import { keyString } from "@gadgets/typed-storage";
import type { OverseerDurableObject } from "../src/overseer.js";
import { buildCompactionState } from "../src/agent-compaction";
import { CodePreviewManager } from "../src/code-preview";
import { COMMIT_1, FIXTURE_OBJECTS, PACKED_OIDS, b64Bytes } from "./git-cache-fixtures";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Exercises the worktree workpiece lifecycle against the real OverseerImpl in workerd: the
// version-4 record-type migration, createWorktree (local commits, full-id resolution, pull
// routing), the barrier's creation record, pinning on first modification (a worktree pins at
// its accepted commit -- WorktreeRecord.pinBase -- by its first write or commit(), never by its
// creation), lazy worktree content in the chat's change stream (edits seed their base texts on
// demand; untouched files are never materialized), the accept's advance of the accepted
// commit, what reverts roll back (never the worktree itself), crash-orphan and chat-deletion
// cleanup, chat-privacy, the delivery of worktree content, summaries
// and proposed-change status to clients, and the reading of logs written when worktrees were
// pinned from birth. Each test gets a fresh DO, whose storage stays at version 0
// (never initialized), so records seeded by tests carry their type explicitly and migration
// tests can arm the constructor trigger by hand.

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

// Like withImpl, but also opens the real OverseerClientInterface (as the owner, build role) over
// the same impl, for the delivery paths that live on the interface rather than the impl. The
// owner id is planted directly rather than going through open()'s first-open initialization,
// and the two open()-time side effects that call out to the owner's user DO are stubbed.
async function withClient(fn: (impl: any, client: Overseer) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`worktrees-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let ownerId = impl.users.newUniqueId().toString();
    impl.ownerId = ownerId;
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    let client = await instance.open(
        ownerId, "owner-profile", new NativeRpcStub<() => void>(() => {}));
    await fn(impl, client);
  });
}

// Lets deliveries through a native stub (which arrive asynchronously) land before asserting.
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

// A fake AiChatSubscriber, recording what the subscription delivers. Wrapped in a native stub
// (which the interface's validation expects), so await settled() before asserting.
function chatSubscriber() {
  let messages: AiChatMessage[] = [];
  let metadata: AiChatMetadata[] = [];
  let rows: { revision: number, change: CodeChange }[] = [];
  let stub = new NativeRpcStub({
    onRpcBroken: () => {},
    streamGeneration: async () => {},
    metadata: async (meta: AiChatMetadata) => { metadata.push(meta); },
    deleted: async () => {},
    message: async (msg: AiChatMessage) => { messages.push(msg); },
    changeApplied: async (_chatId: number, _generation: number, revision: number,
                          _author: unknown, change: CodeChange) => {
      rows.push({ revision, change });
    },
    stream: async () => {},
  } as any) as unknown as RpcStub<AiChatSubscriber>;
  return { stub, messages, metadata, rows };
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
async function createThroughBarrier(impl: any, chatId: number, commitId: string,
                                    bindingName = "REPO")
    : Promise<{ id: number, baseCommit: string, stamp: number }> {
  let created = await impl.createWorktree("Repo", chatId, commitId);
  await barrier(impl, chatId, {
    createdWorktrees: [{ worktreeId: created.id, title: created.title, bindingName }],
  });
  let recording = chatMessages(impl, chatId).findLast(msg => msg.type === "changes" &&
      msg.createdWorktrees?.some(w => w.worktreeId === created.id))!;
  return { id: created.id, baseCommit: created.baseCommit, stamp: recording.sequence };
}

// The chat's live code base, in the absent-means-empty reading both sides use.
function codeBaseOf(impl: any, chatId: number): ChatCodeBase {
  return impl.storage.chatMeta.get(chatId)!.codeBase ?? { pins: [], generation: 0, revision: 0 };
}

// A client submission of `change` at the chat's current stream position, declaring `pins`.
async function submit(impl: any, chatId: number, clientId: string, change: CodeChange,
                      pins?: ChatGadgetPin[]): Promise<{ generation: number, revision: number }> {
  let codeBase = codeBaseOf(impl, chatId);
  return await impl.submitCodeChange(chatId, {
    generation: codeBase.generation, revision: codeBase.revision,
    clientId, seq: 1, change, ...(pins !== undefined ? { pins } : {}),
  }, USER, "user-do");
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
  it("creates a chat-private pending record from a local commit", () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });

    let created = await impl.createWorktree("My Repo", 1, c1);
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

  it("rejects unknown and abbreviated ids, and surfaces provenance loss from the initial pull",
      () => withImpl(async impl => {
    addChat(impl, 1);
    await expect(impl.createWorktree("W", 1, "feed".repeat(10)))
        .rejects.toThrow(/not known to this workspace/);
    // Only full, exact ids: knowing a commit's id is the capability to read it, and a prefix is
    // guessable -- so not even a local commit resolves from one.
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    for (let id of [c1.slice(0, 12), c1.toUpperCase(), "main"]) {
      await expect(impl.createWorktree("W", 1, id)).rejects.toThrow(/not a full git commit id/);
    }
    expect([...impl.storage.gadgets.list()]).toEqual([]);

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
  it("records the creation at the barrier, making the record permanent and pinning nothing",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    // Recording the creation promotes the record at once: a worktree creation proposes
    // nothing, so there is no later accept or revert for a stamp to decide on.
    expect(impl.storage.gadgets.get(id)!.pending).toBeUndefined();
    let changes = chatMessages(impl, 1).find(msg => msg.type === "changes")!;
    expect(changes.createdWorktrees).toEqual(
        [{ worktreeId: id, title: "Repo", bindingName: "REPO" }]);
    expect(changes.createdGadgets).toBeUndefined();
    // Like a gadget, a worktree pins on first modification, not at birth: the creation declares
    // no pin, and the worktree reads as its accepted commit (pinBase) until one does.
    expect(changes.pins).toBeUndefined();
    expect(codeBaseOf(impl, 1).pins).toEqual([]);
    expect(impl.getWorktreePinBase(id)).toBe(c1);
    expect(impl.getGadgetHead(id)).toBeUndefined();
  }));

  it("pins at the accepted commit on the agent's first write, declared on the step's message",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    // The agent declares nothing for a worktree (the barrier derives the pin from the record:
    // the accepted commit is the only base it can have); the pin lands in the live code base
    // with the row and on the step's "changes" message, so reverting the message unpins.
    await barrier(impl, 1, { changes: [
      { change: { [id]: [["new.txt", { set: "fresh\n" }]] } },
    ]});
    expect(codeBaseOf(impl, 1).pins).toEqual([{ gadgetId: id, baseCommit: c1, mergedCommit: c1 }]);
    let step = chatMessages(impl, 1).filter(msg => msg.type === "changes").at(-1)!;
    expect(step.pins).toEqual([{ gadgetId: id, baseCommit: c1 }]);
    expect(await workpieceContent(impl, 1, id)).toEqual({ "new.txt": "fresh\n" });

    // A later step's write declares nothing more.
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "one!\n") }]});
    expect(chatMessages(impl, 1).filter(msg => msg.type === "changes").at(-1)!.pins)
        .toBeUndefined();
    expect(codeBaseOf(impl, 1).pins).toHaveLength(1);
  }));

  it("pins a freshly created worktree too: its content is its base tree, never built up from nothing",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    // A client write to a never-accepted worktree must declare the pin, unlike a pending
    // gadget's; without it the epoch's accept would have no pin to auto-commit under.
    await expect(submit(impl, 1, "cli-nopin", { [id]: [["new.txt", { set: "fresh\n" }]] }))
        .rejects.toThrow(/first modification .* must declare a pin/);
    await submit(impl, 1, "cli-pin", { [id]: [["new.txt", { set: "fresh\n" }]] },
                 [{ gadgetId: id, baseCommit: c1 }]);
    expect(codeBaseOf(impl, 1).pins).toEqual([{ gadgetId: id, baseCommit: c1, mergedCommit: c1 }]);
  }));

  it("applies agent edits lazily: base texts seed on demand, untouched files never materialize",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl,
        { "a.txt": "one\n", "src/b.txt": "bee\n", "src/c.txt": "sea\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    // A later step: a whole-file write (set) plus an edit of a base file the content map has
    // never held -- the edit's base text must seed from the commit the step pins at.
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

  it("accepts a client's pin declaration at the accepted commit exactly, and nothing else",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let c0 = await commitFiles(impl, { "a.txt": "zero\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    let edit = editChange(id, "a.txt", "one\n", "one two\n");

    // Unlike a gadget's head rule there is no parent tolerance: only this chat's accept moves
    // the accepted commit, and that closes the generation the client is rooted in.
    await expect(submit(impl, 1, "cli-none", edit))
        .rejects.toThrow(/first modification .* must declare a pin/);
    await expect(submit(impl, 1, "cli-wrong", edit, [{ gadgetId: id, baseCommit: c0 }]))
        .rejects.toThrow(/does not match the worktree's accepted commit/);
    expect(codeBaseOf(impl, 1).pins).toEqual([]);

    // The declaration establishes the pin with the row; the edit's base seeds from it.
    let ack = await submit(impl, 1, "cli-w", edit, [{ gadgetId: id, baseCommit: c1 }]);
    expect(ack).toEqual({ generation: 0, revision: 1 });
    expect(codeBaseOf(impl, 1).pins).toEqual([{ gadgetId: id, baseCommit: c1, mergedCommit: c1 }]);
    expect(await workpieceContent(impl, 1, id)).toEqual({ "a.txt": "one two\n" });

    // An identical re-declaration is idempotent; a conflicting one is rejected.
    await submit(impl, 1, "cli-again", { [id]: [["b.txt", { set: "b\n" }]] },
                 [{ gadgetId: id, baseCommit: c1 }]);
    await expect(submit(impl, 1, "cli-conflict", { [id]: [["c.txt", { set: "c\n" }]] },
                        [{ gadgetId: id, baseCommit: c0 }]))
        .rejects.toThrow(/concurrently pinned at a different commit/);
  }));

  it("a content rebuild racing a first-pin submission re-resolves instead of misapplying its row",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    // Pause the first cold-cache rebuild after its log fold, so a submission can land -- pin and
    // row -- while the rebuild's metadata snapshot (no pins, no worktree bases) is stale.
    // Neither the message sequence nor the generation moves for that.
    let original = impl.buildChatContent.bind(impl);
    let release!: () => void;
    let paused = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    impl.buildChatContent = async (...args: unknown[]) => {
      let result = await original(...args);
      if (calls++ === 0) await paused;
      return result;
    };
    impl.invalidateChatContent(1);
    let rebuild = impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!);
    await submit(impl, 1, "cli-racer", editChange(id, "a.txt", "one\n", "one!\n"),
                 [{ gadgetId: id, baseCommit: c1 }]);
    release();

    // The stale rebuild must notice the new pin and re-resolve, not apply the edit row against
    // a content that lacks the worktree's base.
    let content = await rebuild;
    expect(Object.fromEntries(content.get(id)!)).toEqual({ "a.txt": "one!\n" });
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
    // A fresh clientId per attempt: a rejected submission never establishes its dedupe session
    // (nor its pin).
    let attempt = (n: number, entry: [string, FileChange]) =>
        submit(impl, 1, `cli-${n}`, { [id]: [entry] }, [{ gadgetId: id, baseCommit: COMMIT_1 }]);

    // The ingestion check mirrors the agent's writeFile tool: a whole-file write or a delete
    // whose path still has a live symlink/gitlink base entry is rejected with the read errors.
    await expect(attempt(1, ["link.md", { set: "clobber\n" }]))
        .rejects.toThrow("link.md is a symlink to README.md");
    await expect(attempt(2, ["vendored", { remove: true }]))
        .rejects.toThrow(/vendored is a submodule \(gitlink\)/);
    // A directory path rejects both shapes: a write could never commit, and removing a
    // directory isn't a thing -- deleting all its files prunes it from the committed tree.
    await expect(attempt(5, ["src", { set: "clobber\n" }]))
        .rejects.toThrow("src is a directory");
    await expect(attempt(6, ["src", { remove: true }]))
        .rejects.toThrow("src is a directory");
    // Edits get the same rejection from their base seeding.
    await expect(attempt(3, ["link.md", editChange(id, "link.md", "x\n", "y\n")[id][0][1]]))
        .rejects.toThrow("link.md is a symlink to README.md");
    expect(codeBaseOf(impl, 1).pins).toEqual([]);
    // A new path passes untouched.
    expect(await attempt(4, ["notes.txt", { set: "hello\n" }]))
        .toEqual({ generation: 0, revision: 1 });
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
  it("a revert covering the creation keeps the worktree, rolling back its content and head",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id, stamp } = await createThroughBarrier(impl, 1, c1);
    await barrier(impl, 1, { changes: [{ change: { [id]: [["new.txt", { set: "fresh\n" }]] } }]});
    let c2 = await commitFiles(impl, { "a.txt": "one\n", "new.txt": "fresh\n" }, [c1]);
    await barrier(impl, 1, { worktreeCommits: [{ worktreeId: id, commit: c2, previousHead: c1 }]});
    expect(codeBaseOf(impl, 1).pins).toHaveLength(1);

    await impl.revertChanges(1, stamp, USER);
    let record = impl.storage.gadgets.get(id)!;
    expect(record).toBeDefined();
    expect(record.pending).toBeUndefined();
    expect(record.headCommit).toBe(c1);
    expect(record.pinBase).toBe(c1);
    expect(codeBaseOf(impl, 1).pins).toEqual([]);
    expect(await workpieceContent(impl, 1, id)).toEqual({});

    // The revert's tail reconciliation doesn't reap it later either (every turn start runs one).
    await impl.reconcilePendingGadgets(1);
    expect(impl.storage.gadgets.get(id)).toBeDefined();
  }));

  it("Discard of a never-accepted worktree's edits keeps the worktree", () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    let proposed = () =>
        impl.chatMetaForClient(impl.storage.chatMeta.get(1)!).proposedChangeWorkpieces;

    // An agent edit and a user edit (still a live row), then the banner's Discard -- the UI's
    // revertChanges(chatId, 0), which covers the creation's message too.
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "one!\n") }]});
    await submit(impl, 1, "cli-user", { [id]: [["b.txt", { set: "bee\n" }]] });
    expect(proposed()).toEqual([id]);

    await impl.revertChanges(1, 0, USER);
    let record = impl.storage.gadgets.get(id)!;
    expect(record).toBeDefined();
    expect(record.pinBase).toBe(c1);
    expect(codeBaseOf(impl, 1).pins).toEqual([]);
    expect(await workpieceContent(impl, 1, id)).toEqual({});
    expect(proposed()).toBeUndefined();

    // Still editable afterwards: the agent's binding resolves, and a new write pins afresh.
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "two\n") }]});
    expect(await workpieceContent(impl, 1, id)).toEqual({ "a.txt": "two\n" });
    expect(proposed()).toEqual([id]);
  }));

  it("promotes a worktree record stamped by an earlier version, even if its creation is reverted",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id, stamp } = await createThroughBarrier(impl, 1, c1);
    // As the earlier version recorded a creation: a sequence stamp instead of promotion.
    impl.storage.gadgets.put({ ...impl.storage.gadgets.get(id)!, pending: { chatId: 1, sequence: stamp } });
    await barrier(impl, 1, { changes: [{ change: { [id]: [["new.txt", { set: "fresh\n" }]] } }]});

    await impl.revertChanges(1, stamp, USER);
    let record = impl.storage.gadgets.get(id)!;
    expect(record).toBeDefined();
    expect(record.pending).toBeUndefined();
  }));

  it("a revert covering the first modification unpins; the worktree reads as its accepted commit",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "one!\n") }]});
    let firstEdit = chatMessages(impl, 1).filter(msg => msg.type === "changes").at(-1)!.sequence;
    await barrier(impl, 1, { changes: [{ change: { [id]: [["b.txt", { set: "b\n" }]] } }]});

    await impl.revertChanges(1, firstEdit, USER);
    expect(impl.storage.gadgets.get(id)).toBeDefined();
    expect(codeBaseOf(impl, 1).pins).toEqual([]);
    expect(await workpieceContent(impl, 1, id)).toEqual({});
    expect(impl.getWorktreePinBase(id)).toBe(c1);
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

  it("an accept covering the creation commits nothing for it",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    await barrier(impl, 1, { changes: [
      { change: { [id]: [["new.txt", { set: "fresh\n" }]] } },
    ]});

    expect(await impl.mergeChanges(1, USER_META, "client-user")).toEqual({ outcome: "merged" });
    let record = impl.storage.gadgets.get(id)!;
    expect(record.pending).toBeUndefined();
    expect(record.chatId).toBe(1);               // still chat-private for life
    expect(record.headCommit).toBe(c1);          // no head-commit work for worktrees
    let merge = chatMessages(impl, 1).find(msg => msg.type === "merge")!;
    expect(merge.commits).toEqual([]);           // nothing committed, nothing gated
    expect(codeBaseOf(impl, 1).pins).toEqual([]); // unpinned in the new epoch
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

// Worktree content reaches clients exactly as gadget content does: the same change rows, pins,
// messages and metadata, with nothing filtered per workpiece type. (An earlier version stripped
// worktree entries from every delivery while the UI could not show them; these tests pin down
// that no such filtering remains on any delivery path.)
describe("client delivery of worktree content", () => {
  it("a chat subscription receives worktree messages, pins, metadata and rows, revisions gapless",
      () => withClient(async (impl, client) => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let created = await impl.createWorktree("Repo", 1, c1);
    let id = created.id;
    let gadget = impl.createGadget("Gadget", "GADGET_X", 1);
    let stepChange: CodeChange = {
      [gadget.id]: [["main.js", { set: "code\n" }]],
      [id]: [["secret.txt", { set: "worktree content\n" }]],
    };
    await barrier(impl, 1, {
      createdWorktrees: [{ worktreeId: id, title: "Repo", bindingName: "REPO" }],
      changes: [{ change: stepChange }],
    });
    let liveChange: CodeChange = { [id]: [["notes.txt", { set: "live\n" }]] };
    let { revision } = await submit(impl, 1, "cli-before", liveChange);

    // Subscribe through the real client interface, replaying from the start: the message
    // catch-up, the metadata catch-up and the retained-row replay are three delivery paths.
    let sub = chatSubscriber();
    await client.subscribeToChat(sub.stub, new Date(0));
    await settled();
    let changes = sub.messages.find(msg => msg.type === "changes")!;
    expect(changes.change).toEqual(stepChange);
    expect(changes.pins).toEqual([{ gadgetId: id, baseCommit: c1 }]);
    expect(changes.createdWorktrees)
        .toEqual([{ worktreeId: id, title: "Repo", bindingName: "REPO" }]);
    let meta = sub.metadata.at(-1)!;
    expect(meta.codeBase!.pins).toEqual([{ gadgetId: id, baseCommit: c1, mergedCommit: c1 }]);
    expect(meta.proposedChangeWorkpieces).toEqual([id, gadget.id].toSorted());
    expect(sub.rows).toEqual([{ revision, change: liveChange }]);

    // The live broadcast is the fourth: a worktree-only row and a gadget row, numbered on.
    let worktreeChange: CodeChange = { [id]: [["secret.txt", { set: "edited\n" }]] };
    let gadgetChange: CodeChange = { [gadget.id]: [["main.js", { set: "code!\n" }]] };
    await submit(impl, 1, "cli-w", worktreeChange);
    await submit(impl, 1, "cli-g", gadgetChange);
    await settled();
    expect(sub.rows.slice(1)).toEqual([
      { revision: revision + 1, change: worktreeChange },
      { revision: revision + 2, change: gadgetChange },
    ]);
  }));

  it("getChatHistory delivers a compaction checkpoint's proposed change whole",
      () => withClient(async (impl, client) => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    await barrier(impl, 1, { changes: [
      { change: { [id]: [["secret.txt", { set: "worktree content\n" }]] } },
    ]});

    // Publish a checkpoint covering the whole log, as a compaction would (see
    // #commitChatCompaction), then read the history page back through the client interface.
    let messages = chatMessages(impl, 1);
    let compactedTo = messages.at(-1)!.sequence + 1;
    impl.storage.chatCompactions.put({
      chatId: 1, compactedTo, summary: "summary",
      ...buildCompactionState(messages, compactedTo, [], undefined),
    });
    impl.storage.chatMeta.put({ ...impl.storage.chatMeta.get(1)!, compactedTo });

    let page = await client.getChatHistory(1);
    expect(page.compacted!.to).toBe(compactedTo);
    expect(page.compacted!.proposedChange)
        .toEqual({ [id]: [["secret.txt", { set: "worktree content\n" }]] });
  }));

  it("a worktree is a proposed change once edited or committed, not merely created; not after accept",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let proposed = () =>
        impl.chatMetaForClient(impl.storage.chatMeta.get(1)!).proposedChangeWorkpieces;

    // Creation alone proposes nothing: a checkout made only to be read must not raise the
    // pending-changes banner.
    let { id, baseCommit } = await createThroughBarrier(impl, 1, c1);
    expect(proposed()).toBeUndefined();

    // An edit pins, which proposes; the accept's epoch reset unpins.
    await barrier(impl, 1, { changes: [{ change: { [id]: [["a.txt", { set: "edited\n" }]] } }]});
    expect(proposed()).toEqual([id]);
    await impl.mergeChanges(1, USER_META, "client-user");
    expect(proposed()).toBeUndefined();

    // A commit() alone pins too: the head advancement is a revertable proposed change.
    let pinBase = impl.storage.gadgets.get(id)!.pinBase;
    await barrier(impl, 1, { worktreeCommits: [{
      worktreeId: id,
      commit: await commitFiles(impl, { "a.txt": "edited\n" }, [baseCommit]),
      previousHead: baseCommit,
    }]});
    expect(proposed()).toEqual([id]);
    await impl.revertChanges(1, 0, USER);
    expect(proposed()).toBeUndefined();
    expect(impl.storage.gadgets.get(id)!.pinBase).toBe(pinBase);
  }));

  it("a mixed chat proposes its gadget and worktree workpieces alike",
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

    let meta = impl.storage.chatMeta.get(1)!;
    expect(impl.proposedChangeWorkpieceIds(1, meta)).toEqual([id, gadget.id].toSorted());
  }));

  it("streams edit previews for worktree targets", () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    // The agent turn's preview manager resolves targets through resolveWorkpieceRoot for the
    // running chat, with no per-type refusal, so a worktree file's edit previews like a gadget
    // file's. This drives the manager with that resolver directly rather than through runAgent
    // (which needs a model): it covers the resolver's verdict, not agent.ts's wiring of it.
    let events: AiChatStreamEvent[] = [];
    let manager = new CodePreviewManager(
        event => events.push(event),
        workpiece => impl.resolveWorkpieceRoot(Number(workpiece), true, 1));
    manager.startToolCall("call_1", "writeFile");
    manager.appendInput("call_1",
        `{"workpiece": "${id}", "filename": "a.txt", "content": "hello"}`);
    manager.finishToolCall("call_1", true);

    expect(events.filter(event => event.type === "editPreviewStart")).toEqual([{
      type: "editPreviewStart", toolCallId: "call_1", file: { workpieceId: id, filename: "a.txt" },
    }]);
    expect(events.filter(event => event.type === "editPreviewDelta")
        .map(event => (event as { delta: string }).delta).join("")).toBe("hello");
  }));
});

// A fake WorkpiecesSubscriber stub, recording what the subscription delivers.
function workpiecesSubscriber() {
  let entries: WorkpieceSummary[] = [];
  let removed: number[] = [];
  let stub: any = {
    dup: () => stub,
    onRpcBroken: () => {},
    entry: async (summary: WorkpieceSummary) => { entries.push(summary); },
    removed: async (id: number) => { removed.push(id); },
    ready: async () => {},
    [Symbol.dispose]: () => {},
  };
  return { stub, entries, removed, worktrees: () => entries.filter(e => e.type === "worktree") };
}

describe("worktrees in the workpiece subscription", () => {
  it("publishes a WorktreeSummary to a build-role subscription, re-delivered as its commits move",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let sub = workpiecesSubscriber();
    impl.subscribeToWorkpieces(sub.stub, true);

    // Creation: delivered at once, pending or not, with the chat it belongs to.
    let { id, baseCommit } = await createThroughBarrier(impl, 1, c1);
    let expected = { id, type: "worktree", title: "Repo", chatId: 1,
                     pinBase: c1, headCommit: c1, baseCommit: c1 };
    expect(sub.worktrees().at(-1)).toEqual(expected);

    // Accepting an edit advances the accepted commit, and the summary follows.
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "one!\n") }]});
    await impl.mergeChanges(1, USER_META, "client-user");
    let pinBase = impl.storage.gadgets.get(id)!.pinBase;
    expect(pinBase).not.toBe(c1);
    expect(sub.worktrees().at(-1)).toEqual({ ...expected, pinBase });

    // An explicit commit advances the head, and its revert rolls the summary back.
    let c2 = await commitFiles(impl, { "a.txt": "one!\n" }, [baseCommit]);
    await barrier(impl, 1, { worktreeCommits: [{ worktreeId: id, commit: c2, previousHead: c1 }]});
    expect(sub.worktrees().at(-1)).toEqual({ ...expected, pinBase, headCommit: c2 });
    await impl.revertChanges(1, 0, USER);
    expect(sub.worktrees().at(-1)).toEqual({ ...expected, pinBase });
    expect(sub.removed).toEqual([]);
  }));

  it("keeps publishing a worktree whose creation a revert covers", () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id, stamp } = await createThroughBarrier(impl, 1, c1);
    await barrier(impl, 1, { changes: [{ change: { [id]: [["new.txt", { set: "fresh\n" }]] } }]});
    let sub = workpiecesSubscriber();
    impl.subscribeToWorkpieces(sub.stub, true);
    expect(sub.worktrees().map(e => e.id)).toEqual([id]);  // the initial listing

    await impl.revertChanges(1, stamp, USER);
    expect(sub.removed).toEqual([]);
  }));

  it("delivers removed() when reconciliation reaps a crash-orphaned worktree",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let created = await impl.createWorktree("Doomed", 1, c1);
    let sub = workpiecesSubscriber();
    impl.subscribeToWorkpieces(sub.stub, true);
    expect(sub.worktrees().map(e => e.id)).toEqual([created.id]);

    await impl.reconcilePendingGadgets(1);
    expect(sub.removed).toEqual([created.id]);
  }));

  it("withholds worktrees, accepted or not, from a use-role subscription",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    let permanent = impl.createGadget("Gadget", "GADGET_X", undefined, undefined, c1);
    let sub = workpiecesSubscriber();
    impl.subscribeToWorkpieces(sub.stub, false);
    expect(sub.entries.map(e => e.id)).toEqual([permanent.id]);

    // Permanence isn't sharing, and neither is acceptance: a worktree is its chat's for life.
    await impl.mergeChanges(1, USER_META, "client-user");
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "one!\n") }]});
    await impl.mergeChanges(1, USER_META, "client-user");
    expect(sub.worktrees()).toEqual([]);
    expect(sub.removed).toEqual([]);
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
    // A commit() is a modification: it pins the (until now unpinned) worktree at its accepted
    // commit, declared on the same message, so the advancement is a revertable proposed
    // change. The accepted commit itself is untouched by explicit commits.
    expect(message.pins).toEqual([{ gadgetId: id, baseCommit: c1 }]);
    expect(codeBaseOf(impl, 1).pins).toEqual([{ gadgetId: id, baseCommit: c1, mergedCommit: c1 }]);
    expect(impl.storage.gadgets.get(id)!.pinBase).toBe(c1);
  }));

  it("fails the barrier on a broken previousHead chain, leaving the head unchanged and unpinned",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1]);

    await expect(barrier(impl, 1, { worktreeCommits: [
      { worktreeId: id, commit: c2, previousHead: c2 },  // wrong: head is c1
    ]})).rejects.toThrow(/head moved during the turn/);
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(c1);
    expect(codeBaseOf(impl, 1).pins).toEqual([]);  // the transaction rolled the pin back too
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

    // Reverting a range spanning both advancements returns the head to before the first, and
    // drops the pin the first established: rejecting the changes rejects their commits.
    await impl.revertChanges(1, firstStamp, USER);
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(c1);
    expect(codeBaseOf(impl, 1).pins).toEqual([]);
    // The commit objects remain (dangling, like auto-commits).
    expect(impl.gitCache.hasLocalObject(c3)).toBe(true);
  }));

  it("a discard restores the head to the epoch's start across edits and several commit()s",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    // Accept the creation, so the worktree is permanent and the epoch starts clean at c1.
    await impl.mergeChanges(1, USER_META, "client-user");

    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "two\n") }]});
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1]);
    await barrier(impl, 1, { worktreeCommits: [{ worktreeId: id, commit: c2, previousHead: c1 }]});
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "two\n", "three\n") }]});
    let c3 = await commitFiles(impl, { "a.txt": "three\n" }, [c2]);
    await barrier(impl, 1, { worktreeCommits: [{ worktreeId: id, commit: c3, previousHead: c2 }]});
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(c3);

    // Discard (the UI's revertChanges(chatId, 0)) reverts the whole epoch: the worktree returns
    // to its last accepted state, head included, and is unpinned again.
    await impl.revertChanges(1, 0, USER);
    let record = impl.storage.gadgets.get(id)!;
    expect(record.headCommit).toBe(c1);
    expect(record.pinBase).toBe(c1);
    expect(codeBaseOf(impl, 1).pins).toEqual([]);
    expect(await workpieceContent(impl, 1, id)).toEqual({});
  }));
});

describe("epoch reset advances the accepted commit", () => {
  it("auto-commits a dirty worktree, advances pinBase, and leaves it unpinned with the head alone",
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

    // The accepted commit advanced to a fresh auto-commit; the head (explicit history) is
    // untouched.
    let record = impl.storage.gadgets.get(id)!;
    expect(record.pinBase).not.toBe(c1);
    expect(record.headCommit).toBe(c1);
    expect(record.baseCommit).toBe(c1);

    // The auto-commit captures the overlay exactly: edits, new files, and deletions (whose
    // emptied directory is pruned), parenting on the old accepted commit.
    expect(await impl.readFileAtCommit(record.pinBase, "a.txt")).toBe("one!\n");
    expect(await impl.readFileAtCommit(record.pinBase, "new.txt")).toBe("fresh\n");
    expect(await impl.readFileAtCommit(record.pinBase, "src/b.txt")).toBeUndefined();
    let [autoCommit] = await impl.gitStore.readCommitLog(record.pinBase, { depth: 1 });
    expect(autoCommit.parents).toEqual([c1]);
    expect(autoCommit.author.name).toBe(USER.name);

    // No re-pin: the new epoch has no rows, so it has no pin, and the merge records none. The
    // worktree reads as the auto-commit's tree until its next modification.
    let merge = chatMessages(impl, 1).find(msg => msg.type === "merge")!;
    expect(merge.worktreePins).toBeUndefined();
    expect(codeBaseOf(impl, 1).pins).toEqual([]);
    expect(await workpieceContent(impl, 1, id)).toEqual({});

    // The next modification pins at the advanced accepted commit (the old one is rejected),
    // and its edit seeds its base from there, not the stale creation base.
    let edit = editChange(id, "a.txt", "one!\n", "one!!\n");
    await expect(submit(impl, 1, "cli-stale", edit, [{ gadgetId: id, baseCommit: c1 }]))
        .rejects.toThrow(/does not match the worktree's accepted commit/);
    await submit(impl, 1, "cli-post", edit, [{ gadgetId: id, baseCommit: record.pinBase }]);
    expect(codeBaseOf(impl, 1).pins).toEqual(
        [{ gadgetId: id, baseCommit: record.pinBase, mergedCommit: record.pinBase }]);
    expect(await workpieceContent(impl, 1, id)).toEqual({ "a.txt": "one!!\n" });

    // The boundary record marks the worktree bridge-eligible (its new accepted commit is the
    // chat's content at the reset) and not discontinuous.
    let boundary = impl.storage.chatChangeBoundaries.get(1)!;
    expect(boundary.boundaries).toContainEqual({ gadgetId: id, commitId: record.pinBase });
    expect(codeBaseOf(impl, 1).prior!.discontinuousGadgets).toEqual([]);
  }));

  it("bridges an edit in flight during the accept, pinning it at the auto-commit",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n", "b.txt": "bee\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "one!\n") }]});
    let before = codeBaseOf(impl, 1);

    await impl.mergeChanges(1, USER_META, "client-user");
    let accepted = impl.storage.gadgets.get(id)!.pinBase;
    expect(codeBaseOf(impl, 1).generation).toBe(before.generation + 1);

    // A client still rooted in the closed generation submits an edit of a file the epoch never
    // touched (so its base is the tree, not a row), declaring the pre-merge pin the server must
    // ignore in favor of the boundary. It lands in the new generation, and re-pins the worktree
    // at the auto-commit -- the base submitCodeChange requires of any worktree pin.
    let ack = await impl.submitCodeChange(1, {
      generation: before.generation, revision: before.revision,
      clientId: "cli-straggler", seq: 1,
      pins: [{ gadgetId: id, baseCommit: c1 }],
      change: editChange(id, "b.txt", "bee\n", "bee!\n"),
    }, USER, "user-do");
    expect(ack).toEqual({ generation: before.generation + 1, revision: 1 });
    expect(codeBaseOf(impl, 1).pins).toEqual(
        [{ gadgetId: id, baseCommit: accepted, mergedCommit: accepted }]);
    expect(await workpieceContent(impl, 1, id)).toEqual({ "b.txt": "bee!\n" });
    expect(await impl.readFileAtCommit(accepted, "a.txt")).toBe("one!\n");
  }));

  it("accepts a clean worktree as a no-op, and one matching its head at the head",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    // Clean: nothing touched this epoch, so nothing was pinned and nothing advances.
    await impl.mergeChanges(1, USER_META, "client-user");
    expect(impl.storage.gadgets.get(id)!.pinBase).toBe(c1);
    expect(chatMessages(impl, 1).find(msg => msg.type === "merge")!.worktreePins)
        .toBeUndefined();
    expect(codeBaseOf(impl, 1).pins).toEqual([]);

    // Edit, then advance the head to a commit capturing exactly that edit (as an explicit
    // commit() would): the accept's flatten equals the head's tree, so the accepted commit
    // becomes the head instead of a new auto-commit.
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
    expect(codeBaseOf(impl, 1).pins).toEqual([]);
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
});

// Chats written while worktrees were pinned from birth: the creation's "changes" message
// declares a birth pin, and each merge re-pins every live worktree in the new generation,
// recording it as `worktreePins`. Nothing writes either anymore; every reader still honors
// them, and one accept moves such a chat into the current regime.
describe("logs from the born-pinned version", () => {
  // Rewrites a chat's log and live code base the way the born-pinned version would have
  // written them: the birth pin on the creation message, `worktreePins` on the merge, and the
  // re-pin in the live code base. Returns the merge's re-pin base.
  function makeLegacy(impl: any, chatId: number, id: number): string {
    let messages = chatMessages(impl, chatId);
    let creation = messages.find(msg => msg.type === "changes" && msg.createdWorktrees)!;
    let record = impl.storage.gadgets.get(id)!;
    impl.storage.chats.put(
        { ...creation, pins: [{ gadgetId: id, baseCommit: record.baseCommit }] });
    let merge = messages.findLast(msg => msg.type === "merge")!;
    impl.storage.chats.put(
        { ...merge, worktreePins: [{ worktreeId: id, baseCommit: record.pinBase }] });
    let meta = impl.storage.chatMeta.get(chatId)!;
    meta.codeBase!.pins.push(
        { gadgetId: id, baseCommit: record.pinBase, mergedCommit: record.pinBase });
    impl.storage.chatMeta.put(meta);
    impl.invalidateChatContent(chatId);
    return record.pinBase;
  }

  it("folds a legacy log to the same content, and declares no pin under the merge's re-pin",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n", "b.txt": "bee\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "one!\n") }]});
    await impl.mergeChanges(1, USER_META, "client-user");
    let repin = makeLegacy(impl, 1, id);

    // The birth pin folds as an ordinary pin in its (closed) epoch; the merge's re-pin roots
    // the new epoch, so a write there seeds from it and declares nothing (the re-pin counts
    // as the surviving declaration).
    await barrier(impl, 1, { changes: [{ change: editChange(id, "b.txt", "bee\n", "bee!\n") }]});
    expect(chatMessages(impl, 1).filter(msg => msg.type === "changes").at(-1)!.pins)
        .toBeUndefined();
    expect(await workpieceContent(impl, 1, id)).toEqual({ "b.txt": "bee!\n" });
    impl.invalidateChatContent(1);
    expect(await workpieceContent(impl, 1, id)).toEqual({ "b.txt": "bee!\n" });

    // A checkpoint whose boundary lies past the merge re-establishes the base from the merge's
    // worktreePins, exactly as before (pins clear at the boundary).
    let messages = chatMessages(impl, 1);
    let state = buildCompactionState(messages, messages.at(-1)!.sequence + 1, [], undefined);
    expect(state.pins).toContainEqual({ gadgetId: id, baseCommit: repin });

    // A client write under the legacy pin needs no declaration, like any pinned write.
    await submit(impl, 1, "cli-legacy", { [id]: [["c.txt", { set: "c\n" }]] });
    expect(await workpieceContent(impl, 1, id)).toEqual({ "b.txt": "bee!\n", "c.txt": "c\n" });
  }));

  it("one accept drops a legacy pin with nothing to merge, leaving the accepted commit alone",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    await impl.mergeChanges(1, USER_META, "client-user");
    let repin = makeLegacy(impl, 1, id);
    expect(repin).toBe(c1);
    let generation = codeBaseOf(impl, 1).generation;
    expect(impl.getProposedChanges(1)).toEqual([]);
    // The vacuous pin reads as a proposed change (a spurious banner on an idle chat), which the
    // accept below is the way out of -- deliberately not migrated.
    expect(impl.chatMetaForClient(impl.storage.chatMeta.get(1)!).proposedChangeWorkpieces)
        .toEqual([id]);

    // No message is proposed, yet the accept runs the epoch reset rather than returning early:
    // the pin was vacuous, so the planning finds the worktree clean, and no auto-commit is
    // written.
    expect(await impl.mergeChanges(1, USER_META, "client-user")).toEqual({ outcome: "merged" });
    expect(codeBaseOf(impl, 1).pins).toEqual([]);
    expect(codeBaseOf(impl, 1).generation).toBe(generation + 1);
    expect(impl.storage.gadgets.get(id)!.pinBase).toBe(c1);
    expect(chatMessages(impl, 1).at(-1)!.type).toBe("merge");
    expect(impl.chatMetaForClient(impl.storage.chatMeta.get(1)!).proposedChangeWorkpieces)
        .toBeUndefined();

    // Now in the current regime: another accept with nothing proposed is a true no-op.
    await impl.mergeChanges(1, USER_META, "client-user");
    expect(codeBaseOf(impl, 1).generation).toBe(generation + 1);
  }));

  it("a legacy pin survives reverts and is retired only by the accept",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    await impl.mergeChanges(1, USER_META, "client-user");
    makeLegacy(impl, 1, id);

    // A write under the legacy pin, then a revert of it: the pin's declaring message is the
    // merge, which a revert never covers, so the pin stays and the worktree stays reviewable.
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "one!\n") }]});
    let stamp = chatMessages(impl, 1).at(-1)!.sequence;
    await impl.revertChanges(1, stamp, USER);
    expect(codeBaseOf(impl, 1).pins.map((pin: ChatGadgetPin) => pin.gadgetId)).toEqual([id]);
    expect(await workpieceContent(impl, 1, id)).toEqual({});

    // Another write, then the accept: the auto-commit captures it and the pin is gone.
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "one?\n") }]});
    await impl.mergeChanges(1, USER_META, "client-user");
    expect(codeBaseOf(impl, 1).pins).toEqual([]);
    expect(await impl.readFileAtCommit(impl.storage.gadgets.get(id)!.pinBase, "a.txt"))
        .toBe("one?\n");
  }));
});
