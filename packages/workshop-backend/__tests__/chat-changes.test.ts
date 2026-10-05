import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { RpcStub } from "capnweb";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiChatSubscriber, CodeChangeSubmission,
  Overseer,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent, type CodeChange }
  from "@gadgets/workshop-shared/code-change";
import { keyString } from "@gadgets/typed-storage";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Exercises the chat change-stream lifecycle -- submitCodeChange's validation/transform/dedupe,
// lazy pin establishment, materialization and its watermark, the accept flow's epoch reset and
// straggler bridge, update-from-mainline as a merge commit that the pin re-roots at, and
// destructive bumps (revert / draft discard) -- against the real OverseerImpl running in
// workerd, over real storage and a real git object store. Each test gets a fresh DO.

const USER: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
const BOB: AiChatAuthorInfo = { type: "user", id: "bob@example.com", name: "Bob" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
const USER_META = { profile: USER };
const USER_DO_ID = "alice-user-do";

let doCounter = 0;
async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`chat-changes-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl);
  });
}

// Like withImpl, with the real client interface opened over the Overseer as its owner.
async function withClient(fn: (impl: any, client: Overseer) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`chat-changes-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let ownerId = impl.users.newUniqueId().toString();
    impl.ownerId = ownerId;
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await instance.open(ownerId, "owner-profile", notifyClosed);
    await fn(impl, client);
  });
}

// Lets deliveries through a native stub (which arrive asynchronously) land before asserting.
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

function addGadget(impl: any, id: number, bindingName: string, commitId?: string): void {
  impl.storage.gadgets.put({
    type: "gadget", id, title: bindingName, created: new Date(0), bindingName, bindings: {},
    ...(commitId !== undefined ? { commitId } : {}),
  });
}

function setHead(impl: any, id: number, commitId: string): void {
  let record = impl.storage.gadgets.get(id)!;
  record.commitId = commitId;
  impl.storage.gadgets.put(record);
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

// Builds the change a client would submit: the diff of one gadget's files from `before` to `after`.
function editChange(gadgetId: number, before: Record<string, string>,
                    after: Record<string, string>): CodeChange {
  let content = (files: Record<string, string>): CodeContent =>
      new Map([[gadgetId, new Map(Object.entries(files))]]);
  return diffFiles(content(before), content(after));
}

async function submit(impl: any, chatId: number, submission: CodeChangeSubmission,
                      author: AiChatAuthorInfo = USER, userId: string = USER_DO_ID)
    : Promise<{generation: number, revision: number}> {
  return await impl.submitCodeChange(chatId, submission, author, userId);
}

function chatMessages(impl: any, chatId: number): AiChatMessage[] {
  return [...impl.storage.chats.list({ prefix: `${keyString(chatId)}.` })];
}

// The chat's current content for one gadget, as a plain object.
async function gadgetContent(
    impl: any, chatId: number, gadgetId: number): Promise<Record<string, string>> {
  let content = await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!);
  return Object.fromEntries(content.get(gadgetId) ?? new Map());
}

function liveRows(impl: any, chatId: number): any[] {
  let meta = impl.storage.chatMeta.get(chatId)!;
  return impl.listLiveChatChanges(chatId, meta.codeBase?.generation ?? 0);
}

describe("submitCodeChange", () => {
  it("establishes a pin, appends rows, and materialization stamps the declaration and watermark",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    let ack = await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli-a", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "one\nedited\n" }),
    });
    expect(ack).toEqual({ generation: 0, revision: 1 });

    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase).toMatchObject({ generation: 0, revision: 1 });
    expect(codeBase.pins).toEqual([{ gadgetId: 1, baseCommit: c1, mergedCommit: c1 }]);

    // A follow-up submission to the already-pinned gadget needs no declaration.
    let ack2 = await submit(impl, 1, {
      generation: 0, revision: 1, clientId: "cli-a", seq: 2,
      change: editChange(1, { "a.txt": "one\nedited\n" }, { "a.txt": "// top\none\nedited\n" }),
    });
    expect(ack2).toEqual({ generation: 0, revision: 2 });
    expect(await gadgetContent(impl, 1, 1)).toEqual({ "a.txt": "// top\none\nedited\n" });

    // Materialization composes the rows into one "changes" message, stamps the (previously
    // unlogged) pin declaration, and records the generation-qualified watermark; the rows
    // retire but the composed content is unchanged.
    impl.materializeChatChanges(1);
    let changes = chatMessages(impl, 1).filter(msg => msg.type === "changes");
    expect(changes).toHaveLength(1);
    expect(changes[0].pins).toEqual([{ gadgetId: 1, baseCommit: c1 }]);
    expect(changes[0].watermark).toEqual({ changesGeneration: 0, throughRevision: 2 });
    expect(changes[0].change).toBeDefined();
    expect(liveRows(impl, 1)).toEqual([]);
    expect(await gadgetContent(impl, 1, 1)).toEqual({ "a.txt": "// top\none\nedited\n" });

    // Content reconstruction from the log alone agrees.
    let rebuilt = await impl.buildChatContent(1);
    expect(Object.fromEntries(rebuilt.get(1)!)).toEqual({ "a.txt": "// top\none\nedited\n" });
  }));

  it("accepts a pin two first-parent steps behind the head but rejects older bases",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1]);
    let c3 = await commitFiles(impl, { "a.txt": "three\n" }, [c2]);
    let c4 = await commitFiles(impl, { "a.txt": "four\n" }, [c3]);
    addGadget(impl, 1, "APP", c4);
    addChat(impl, 1);

    await expect(submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli-a", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "xone\n" }),
    })).rejects.toThrow(/does not match the gadget's current head/);

    // Two steps back is tolerated: the client raced one accept, which moves the head two steps
    // when it writes on top of a merge commit.
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli-b", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c2 }],
      change: editChange(1, { "a.txt": "two\n" }, { "a.txt": "xtwo\n" }),
    });
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins[0].baseCommit).toBe(c2);
  }));

  it("rejects a pin at a blueprint release the head merged, which was never the head",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let release = await commitFiles(impl, { "a.txt": "released\n" });
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1, release]);
    addGadget(impl, 1, "APP", c2);
    addChat(impl, 1);

    await expect(submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli-a", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: release }],
      change: editChange(1, { "a.txt": "released\n" }, { "a.txt": "xreleased\n" }),
    })).rejects.toThrow(/does not match the gadget's current head/);

    // The head's first parent is the head before it, which a client may still be editing.
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli-b", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "xone\n" }),
    });
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins[0].baseCommit).toBe(c1);
  }));

  it("rejects stale generations, conflicting pins, headless pins, and missing declarations",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1]);
    addGadget(impl, 1, "APP", c2);
    addGadget(impl, 2, "EMPTY");  // no committed code, not pending: unreachable by changes
    addChat(impl, 1);

    let change = editChange(1, { "a.txt": "two\n" }, { "a.txt": "xtwo\n" });

    // A generation the chat never had (or destructively closed) is unbridgeable.
    await expect(submit(impl, 1,
        { generation: 1, revision: 0, clientId: "c1", seq: 1, change }))
        .rejects.toThrow(/rebuild from fresh metadata/);

    // A pin for a gadget with no committed code is meaningless.
    await expect(submit(impl, 1, {
      generation: 0, revision: 0, clientId: "c2", seq: 1,
      pins: [{ gadgetId: 2, baseCommit: c2 }],
      change: { 2: [["a.txt", { set: "x" }]] },
    })).rejects.toThrow(/no committed code/);

    // The first modification of a permanent gadget must declare a pin.
    await expect(submit(impl, 1,
        { generation: 0, revision: 0, clientId: "c3", seq: 1, change }))
        .rejects.toThrow(/must declare a pin/);

    // First pin wins; a racing declaration at a different base is refused (the loser's content
    // diverges, so its keystrokes must be discarded)...
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "c4", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c2 }], change,
    });
    await expect(submit(impl, 1, {
      generation: 0, revision: 0, clientId: "c5", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }], change,
    })).rejects.toThrow(/concurrently pinned/);
    // ...but the identical declaration is accepted idempotently.
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "c6", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c2 }], change,
    });
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toHaveLength(1);
  }));

  it("validates the transformed change against current content", () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    // An edit whose before-length doesn't match the pinned base is rejected outright.
    await expect(submit(impl, 1, {
      generation: 0, revision: 0, clientId: "c1", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: { 1: [["a.txt", { edit: [2, [2, "x"], 96] }]] },  // expects a 100-unit file
    })).rejects.toThrow(/length mismatch/);
  }));

  it("transforms a late submission over retired rows (materialization stales nobody)",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "middle\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "alice", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "middle\n" }, { "a.txt": "top\nmiddle\n" }),
    });
    impl.materializeChatChanges(1);
    expect(liveRows(impl, 1)).toEqual([]);

    // Bob is still rooted at revision 0, inside the materialized range: the retired rows are
    // the transform window, so the submission lands instead of being rejected.
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "bob", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "middle\n" }, { "a.txt": "middle\nbottom\n" }),
    }, BOB, "bob-user-do");
    expect(await gadgetContent(impl, 1, 1)).toEqual({ "a.txt": "top\nmiddle\nbottom\n" });
  }));

  it("rejects a base beyond the retention horizon", () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "middle\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "alice", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "middle\n" }, { "a.txt": "top\nmiddle\n" }),
    });
    impl.materializeChatChanges(1);

    // Age the retired row past the horizon and trigger the lazy prune with another
    // materialization cycle.
    for (let row of Array.from(impl.storage.chatChanges.list({ prefix: `${keyString(1)}.` }))) {
      (row as any).timestamp = new Date(Date.now() - 10 * 60_000);
      impl.storage.chatChanges.put(row);
    }
    await submit(impl, 1, {
      generation: 0, revision: 1, clientId: "alice", seq: 2,
      change: editChange(1, { "a.txt": "top\nmiddle\n" }, { "a.txt": "top\nmiddle\nmore\n" }),
    });
    impl.materializeChatChanges(1);

    // A submission still rooted at revision 0 has nothing to transform over: reject, never
    // mistransform across the gap.
    await expect(submit(impl, 1, {
      generation: 0, revision: 0, clientId: "bob", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "middle\n" }, { "a.txt": "middle\nbottom\n" }),
    }, BOB, "bob-user-do")).rejects.toThrow(/rebuild from fresh metadata/);
  }));
});

describe("submitCodeChange dedupe", () => {
  it("rejects out-of-sequence seqs and unknown client sessions", () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    let submission: CodeChangeSubmission = {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "xone\n" }),
    };
    await submit(impl, 1, submission);

    // Sequence discipline: only record+1 continues; anything else is a protocol violation.
    await expect(submit(impl, 1, { ...submission, seq: 3 }))
        .rejects.toThrow(/Out-of-sequence/);
    await expect(submit(impl, 1, { ...submission, clientId: "fresh", seq: 2 }))
        .rejects.toThrow(/Unknown client session/);
  }));

  it("recognition survives materialization, epoch resets, and destructive bumps",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    let submission: CodeChangeSubmission = {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "xone\n" }),
    };
    let ack = await submit(impl, 1, submission);

    // After materialization (rows retired).
    impl.materializeChatChanges(1);
    expect(await submit(impl, 1, submission)).toEqual(ack);

    // After an epoch reset (generation closed content-preservingly).
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    expect(await submit(impl, 1, submission)).toEqual(ack);

    // After a destructive bump (rows erased): the retry is still recognized -- an unrecognized
    // one would re-apply as a fresh first change.
    let head = impl.storage.gadgets.get(1)!.commitId!;
    await submit(impl, 1, {
      generation: 1, revision: 0, clientId: "cli2", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: head }],
      change: editChange(1, { "a.txt": "xone\n" }, { "a.txt": "zxone\n" }),
    });
    impl.discardChatDraftChanges(1);
    expect(await submit(impl, 1, submission)).toEqual(ack);
  }));

  it("scopes dedupe records to the authenticated user", () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "shared-id", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "xone\n" }),
    });

    // Bob reusing Alice's (public) clientId neither reads nor advances her record: his seq 1
    // is a fresh first change under his own record, and it actually applies.
    await submit(impl, 1, {
      generation: 0, revision: 1, clientId: "shared-id", seq: 1,
      change: editChange(1, { "a.txt": "xone\n" }, { "a.txt": "xone\nbob\n" }),
    }, BOB, "bob-user-do");
    expect(liveRows(impl, 1)).toHaveLength(2);
    expect(await gadgetContent(impl, 1, 1)).toEqual({ "a.txt": "xone\nbob\n" });
  }));

  it("acknowledges, not re-applies, a duplicate landing during the prefetch awaits",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    // Two copies of one submission in flight at once (a client retry racing its original):
    // both pass the pre-prefetch dedupe read before either appends -- the prefetches await
    // non-storage I/O, where the input gate does not hold -- so the synchronous tail's
    // dedupe re-check is what must turn the loser into an acknowledgement.
    let submission: CodeChangeSubmission = {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "one\nedited\n" }),
    };
    let [a, b] = await Promise.all([submit(impl, 1, submission), submit(impl, 1, submission)]);
    expect(a).toEqual({ generation: 0, revision: 1 });
    expect(b).toEqual(a);
    expect(liveRows(impl, 1)).toHaveLength(1);
    expect(await gadgetContent(impl, 1, 1)).toEqual({ "a.txt": "one\nedited\n" });
  }));
});

describe("mergeChanges", () => {
  it("commits, fast-forwards, and closes the epoch content-preservingly",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "one\nedited\n" }),
    });

    // The accept sweeps the live rows in itself (no prior materialization needed).
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });

    let head = impl.storage.gadgets.get(1)!.commitId!;
    expect(head).not.toBe(c1);
    expect(await impl.gitStore.readCommitFiles(head))
        .toEqual(new Map([["a.txt", "one\nedited\n"]]));
    expect((await impl.gitStore.readCommitLog(head, { depth: 1 }))[0].parents).toEqual([c1]);

    let merges = chatMessages(impl, 1).filter(msg => msg.type === "merge");
    expect(merges).toHaveLength(1);
    expect(merges[0].epochBoundary).toBe(true);
    expect(merges[0].commits).toEqual([{ gadgetId: 1, commitId: head }]);

    // Epoch reset: pins evaporate, the stream restarts under a new generation, and `prior`
    // names the closed stream for clients (and the straggler bridge).
    expect(impl.storage.chatMeta.get(1)!.codeBase).toEqual({
      pins: [], generation: 1, revision: 0, epoch: merges[0].sequence,
      prior: { generation: 0, finalRevision: 1, discontinuousGadgets: [] },
    });
    expect(liveRows(impl, 1)).toEqual([]);
    expect(impl.proposedChangeWorkpieceIds(1, impl.storage.chatMeta.get(1)!)).toEqual([]);
    expect(await gadgetContent(impl, 1, 1)).toEqual({});

    // A second epoch re-pins lazily against the new head and replays independently.
    await submit(impl, 1, {
      generation: 1, revision: 0, clientId: "cli", seq: 2,
      pins: [{ gadgetId: 1, baseCommit: head }],
      change: editChange(1, { "a.txt": "one\nedited\n" }, { "a.txt": "top\none\nedited\n" }),
    });
    impl.materializeChatChanges(1);
    expect(await gadgetContent(impl, 1, 1)).toEqual({ "a.txt": "top\none\nedited\n" });
  }));

  it("gives up when a row lands during the accept's awaits, preserving it",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "one\nfirst\n" }),
    });

    // Race a keystroke into the accept's await window: submitCodeChange acknowledges it against the
    // pre-reset generation (no lock, no log append), so the accept must neither discard it with
    // the epoch reset nor silently sweep the mid-keystroke state -- it gives up, leaving the
    // chat untouched.
    let origWrite = impl.gitStore.writeFilesAsCommit.bind(impl.gitStore);
    let injected = false;
    impl.gitStore.writeFilesAsCommit = async (...args: unknown[]) => {
      if (!injected) {
        injected = true;
        await submit(impl, 1, {
          generation: 0, revision: 1, clientId: "cli", seq: 2,
          change: editChange(1, { "a.txt": "one\nfirst\n" }, { "a.txt": "late\none\nfirst\n" }),
        });
      }
      return await origWrite(...args);
    };

    await expect(impl.mergeChanges(1, USER_META, "user-do-id"))
        .rejects.toThrow(/actively edited/);
    expect(impl.storage.gadgets.get(1)!.commitId).toBe(c1);  // head did not move
    expect(impl.storage.chatMeta.get(1)!.codeBase!.generation).toBe(0);  // no epoch reset
    expect(liveRows(impl, 1)).toHaveLength(1);  // the raced row survived (first was materialized)

    // Once the typing settles, a retry merges everything, raced keystroke included.
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    let head = impl.storage.gadgets.get(1)!.commitId!;
    expect(await impl.gitStore.readCommitFiles(head))
        .toEqual(new Map([["a.txt", "late\none\nfirst\n"]]));
  }));
});

describe("straggler bridge", () => {
  // Sets up a chat that edited gadget 1 and merged: generation 0 closed content-preservingly.
  async function setupMergedChat(impl: any): Promise<{ c1: string, head: string }> {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "typist", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "one\nedited\n" }),
    });
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    return { c1, head: impl.storage.gadgets.get(1)!.commitId! };
  }

  it("carries a submission across a merge, pinning at the boundary commit",
      () => withImpl(async impl => {
    let { c1, head } = await setupMergedChat(impl);

    // The typist's next keystroke was composed against the closed generation's tip (gen 0,
    // rev 1) and even carries the pre-merge pin declaration. The bridge lands it in the new
    // generation -- the merge's commit *is* the flatten, so the cross-generation step is the
    // identity map -- and derives the pin from the recorded boundary, ignoring the declaration.
    let ack = await submit(impl, 1, {
      generation: 0, revision: 1, clientId: "typist", seq: 2,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\nedited\n" }, { "a.txt": "one\nedited\nmore\n" }),
    });
    expect(ack).toEqual({ generation: 1, revision: 1 });

    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase.pins).toEqual([{ gadgetId: 1, baseCommit: head, mergedCommit: head }]);
    expect(await gadgetContent(impl, 1, 1)).toEqual({ "a.txt": "one\nedited\nmore\n" });

    // Typing straight through the accept: the next accept fast-forwards from the new head.
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    let newHead = impl.storage.gadgets.get(1)!.commitId!;
    expect((await impl.gitStore.readCommitLog(newHead, { depth: 1 }))[0].parents)
        .toEqual([head]);
  }));

  it("bridges when mainline moved after the merge: the pin lands on a parent of tip",
      () => withImpl(async impl => {
    let { head } = await setupMergedChat(impl);

    // Another chat commits on top of the merge before the straggler arrives.
    let c3 = await commitFiles(impl, { "a.txt": "one\nedited\ntheirs\n" }, [head]);
    setHead(impl, 1, c3);

    let ack = await submit(impl, 1, {
      generation: 0, revision: 1, clientId: "typist", seq: 2,
      change: editChange(1, { "a.txt": "one\nedited\n" }, { "a.txt": "one\nedited\nmore\n" }),
    });
    expect(ack).toEqual({ generation: 1, revision: 1 });

    // The boundary commit is now a parent of tip: the pin lands there (the tip-or-parent
    // grace), leaving the chat ordinarily stale.
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toEqual(
        [{ gadgetId: 1, baseCommit: head, mergedCommit: head }]);
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "stale" });
  }));

  it("rejects changes touching a bridge-ineligible gadget, reported in prior.discontinuousGadgets",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let d1 = await commitFiles(impl, { "b.txt": "bee\n" });
    addGadget(impl, 1, "APP", c1);
    addGadget(impl, 2, "OTHER", d1);
    addChat(impl, 1);

    // Gadget 2 is pinned but ends up with no net change (edit then undo); gadget 1 carries the
    // real change.
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "typist", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "one\nedited\n" }),
    });
    await submit(impl, 1, {
      generation: 0, revision: 1, clientId: "typist", seq: 2,
      pins: [{ gadgetId: 2, baseCommit: d1 }],
      change: editChange(2, { "b.txt": "bee\n" }, { "b.txt": "xbee\n" }),
    });
    await submit(impl, 1, {
      generation: 0, revision: 2, clientId: "typist", seq: 3,
      change: editChange(2, { "b.txt": "xbee\n" }, { "b.txt": "bee\n" }),
    });

    // Mainline moves on gadget 2 (its pin's mergedCommit falls behind), then the merge lands:
    // gadget 2's pin evaporates while its content visibly snaps from d1's tree to d2's.
    let d2 = await commitFiles(impl, { "b.txt": "changed\n" }, [d1]);
    setHead(impl, 2, d2);
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    expect(impl.storage.chatMeta.get(1)!.codeBase!.prior!.discontinuousGadgets).toEqual([2]);

    // A straggler touching gadget 2 cannot be carried across; one touching only gadget 1 can.
    await expect(submit(impl, 1, {
      generation: 0, revision: 3, clientId: "typist", seq: 4,
      change: editChange(2, { "b.txt": "bee\n" }, { "b.txt": "bee\nmore\n" }),
    })).rejects.toThrow(/rebuild from fresh metadata/);
    let head1 = impl.storage.gadgets.get(1)!.commitId!;
    let ack = await submit(impl, 1, {
      generation: 0, revision: 3, clientId: "typist2", seq: 1,
      change: editChange(1, { "a.txt": "one\nedited\n" }, { "a.txt": "one\nedited\nmore\n" }),
    });
    expect(ack).toEqual({ generation: 1, revision: 1 });
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toEqual(
        [{ gadgetId: 1, baseCommit: head1, mergedCommit: head1 }]);
  }));

  it("bridges a net-unchanged pin whose mergedCommit reached head via update-from-mainline",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let d1 = await commitFiles(impl, { "b.txt": "bee\n" });
    addGadget(impl, 1, "APP", c1);
    addGadget(impl, 2, "OTHER", d1);
    addChat(impl, 1);

    // Pin both; gadget 2 nets out unchanged.
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "typist", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "one\nedited\n" }),
    });
    await submit(impl, 1, {
      generation: 0, revision: 1, clientId: "typist", seq: 2,
      pins: [{ gadgetId: 2, baseCommit: d1 }],
      change: editChange(2, { "b.txt": "bee\n" }, { "b.txt": "xbee\n" }),
    });
    await submit(impl, 1, {
      generation: 0, revision: 2, clientId: "typist", seq: 3,
      change: editChange(2, { "b.txt": "xbee\n" }, { "b.txt": "bee\n" }),
    });

    // Mainline moves on gadget 2, but this time the chat updates from mainline first. The
    // chat's gadget-2 files are d1's own, so it has nothing of its own to merge: the pin
    // re-roots at d2 itself, and the stream restarts under a new generation.
    let d2 = await commitFiles(impl, { "b.txt": "changed\n" }, [d1]);
    setHead(impl, 2, d2);
    let { conflictPaths } = await impl.updateChatFromMainline(1, USER);
    expect(conflictPaths).toEqual([]);
    expect(await gadgetContent(impl, 1, 2)).toEqual({ "b.txt": "changed\n" });
    expect(impl.storage.chatMeta.get(1)!.codeBase!).toMatchObject({ generation: 1, revision: 0 });

    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    let prior = impl.storage.chatMeta.get(1)!.codeBase!.prior!;
    expect(prior).toMatchObject({ generation: 1, discontinuousGadgets: [] });

    // A straggler touching gadget 2 -- expressed against d2's content, which carried across by
    // identity -- bridges cleanly and pins gadget 2 at its boundary commit (head d2).
    let ack = await submit(impl, 1, {
      generation: 1, revision: prior.finalRevision, clientId: "typist", seq: 4,
      change: editChange(2, { "b.txt": "changed\n" }, { "b.txt": "changed\nmore\n" }),
    });
    expect(ack).toEqual({ generation: 2, revision: 1 });
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toEqual(
        [{ gadgetId: 2, baseCommit: d2, mergedCommit: d2 }]);
  }));

  it("rejects a bridged change when the new generation pinned the gadget at a different base",
      () => withImpl(async impl => {
    let { head } = await setupMergedChat(impl);

    // Mainline moves past the boundary, and a new-epoch editor pins at the *new* head first.
    let c3 = await commitFiles(impl, { "a.txt": "one\nedited\ntheirs\n" }, [head]);
    setHead(impl, 1, c3);
    await submit(impl, 1, {
      generation: 1, revision: 0, clientId: "fresh", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c3 }],
      change: editChange(1, { "a.txt": "one\nedited\ntheirs\n" },
                         { "a.txt": "one\nedited\ntheirs\nnew\n" }),
    });

    // Carrying a boundary-rooted change onto content pinned at a different base would need a
    // cross-base merge -- update-from-mainline's job, not transform's.
    await expect(submit(impl, 1, {
      generation: 0, revision: 1, clientId: "typist", seq: 2,
      change: editChange(1, { "a.txt": "one\nedited\n" }, { "a.txt": "one\nedited\nmore\n" }),
    })).rejects.toThrow(/rebuild from fresh metadata/);
  }));
});

describe("revert and draft discard", () => {
  it("rolls back reverted pins, erases rows, and bumps the generation destructively",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "xone\n" }),
    });
    let materialized = impl.materializeChatChanges(1)!;

    // A live row recorded after the declaration dies with the revert.
    await submit(impl, 1, {
      generation: 0, revision: 1, clientId: "cli", seq: 2,
      change: editChange(1, { "a.txt": "xone\n" }, { "a.txt": "yxone\n" }),
    });

    await impl.revertChanges(1, materialized.sequence, USER);

    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase.pins).toEqual([]);  // the declaring message was reverted
    expect(codeBase).toMatchObject({ generation: 1, revision: 0 });
    expect(codeBase.prior).toBeUndefined();  // destructive: no bridge
    expect([...impl.storage.chatChanges.list({ prefix: `${keyString(1)}.` })]).toEqual([]);

    // The reverted declaration's base no longer applies during reconstruction.
    expect(await gadgetContent(impl, 1, 1)).toEqual({});
  }));

  it("discardChatDraftChanges drops unlogged pins but keeps declared ones",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let d1 = await commitFiles(impl, { "b.txt": "bee\n" });
    addGadget(impl, 1, "APP", c1);
    addGadget(impl, 2, "OTHER", d1);
    addChat(impl, 1);

    // Pin 1 is declared in the log (materialized); pin 2 exists only in metadata, backed by
    // rows that never materialized.
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "xone\n" }),
    });
    impl.materializeChatChanges(1);
    await submit(impl, 1, {
      generation: 0, revision: 1, clientId: "cli", seq: 2,
      pins: [{ gadgetId: 2, baseCommit: d1 }],
      change: editChange(2, { "b.txt": "bee\n" }, { "b.txt": "ybee\n" }),
    });

    impl.discardChatDraftChanges(1);

    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase.pins.map((pin: { gadgetId: number }) => pin.gadgetId)).toEqual([1]);
    expect(codeBase).toMatchObject({ generation: 1, revision: 0 });
    expect(await gadgetContent(impl, 1, 1)).toEqual({ "a.txt": "xone\n" });
    expect(await gadgetContent(impl, 1, 2)).toEqual({});
  }));

  it("a revert that affects no materialized changes still discards live rows",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    // One accepted batch, then a live row (with its unlogged pin) in the new epoch.
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "xone\n" }),
    });
    let materialized = impl.materializeChatChanges(1)!;
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    let head = impl.storage.gadgets.get(1)!.commitId!;
    await submit(impl, 1, {
      generation: 1, revision: 0, clientId: "cli", seq: 2,
      pins: [{ gadgetId: 1, baseCommit: head }],
      change: editChange(1, { "a.txt": "xone\n" }, { "a.txt": "yxone\n" }),
    });
    expect(liveRows(impl, 1)).toHaveLength(1);

    // Every message at or after revertFrom is already merged, so no revert message is
    // recorded -- but live rows are strictly newer than every message, hence inside the
    // reverted range: they are discarded with their unlogged pin, and the generation bumps.
    await impl.revertChanges(1, materialized.sequence, USER);
    expect(chatMessages(impl, 1).filter(msg => msg.type === "revert")).toEqual([]);
    expect(liveRows(impl, 1)).toEqual([]);
    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase.pins).toEqual([]);
    expect(codeBase).toMatchObject({ generation: 2, revision: 0 });
  }));

  // Seeds the shape the git-storage migration leaves behind (see overseer-git-migration.ts): legacy
  // pre-conversion messages (optionally including a surviving "changes" message, which
  // post-conversion is a content-less proposed marker -- its Yjs payload is retired and its
  // content lives in the boundary's collapsed change), then the conversion boundary carrying
  // the collapsed legacy edits (a pinned gadget's edit plus a carried pending creation, whose
  // record the migration re-stamped onto the boundary), mirrored into codeBase. Returns the
  // boundary's sequence.
  function seedConvertedChat(impl: any, c1: string, legacyChanges: boolean): number {
    impl.storage.chats.put({
      chatId: 1, sequence: impl.nextChatSequence(1), timestamp: impl.getChatTimestamp(),
      author: USER, type: "message", message: "legacy history",
    });
    if (legacyChanges) {
      impl.storage.chats.put({
        chatId: 1, sequence: impl.nextChatSequence(1), timestamp: impl.getChatTimestamp(),
        author: AGENT, type: "changes",
      });
    }
    let boundary = impl.nextChatSequence(1);
    impl.storage.chats.put({
      chatId: 1, sequence: boundary, timestamp: impl.getChatTimestamp(), author: USER,
      type: "changes", conversionBoundary: true,
      change: {
        "1": [["a.txt", { set: "one\nlegacy\n" }]],
        "2": [["mine.js", { set: "mine\n" }]],
      },
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      createdGadgets: [{ gadgetId: 2, title: "Mine", bindingName: "MINE" }],
    });
    impl.storage.gadgets.put({
      type: "gadget", id: 2, title: "Mine", created: new Date(0), bindingName: "MINE",
      bindings: {}, pending: { chatId: 1, sequence: boundary },
    });
    let meta = impl.storage.chatMeta.get(1)!;
    meta.codeBase = {
      pins: [{ gadgetId: 1, baseCommit: c1, mergedCommit: c1 }],
      generation: 0, epoch: boundary, revision: 0,
    };
    // A stale cached flag, as rows written before proposed-ness became derived may carry
    // (see StoredChatMetadata): nothing reads it, and delivery must strip it.
    meta.hasProposedChanges = true;
    impl.storage.chatMeta.put(meta);
    return boundary;
  }

  it("discard-all reverts through the conversion boundary and its legacy batches",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);
    let boundary = seedConvertedChat(impl, c1, true);

    // Reverting at (or anywhere above) the legacy batch while erasing the boundary would strand
    // the batch: its content lives only in the boundary's collapsed change. Refused.
    await expect(impl.revertChanges(1, boundary, USER))
        .rejects.toThrow(/discarded together/);

    // The banner's discard-all (revertFrom 0) covers everything and works: the pin rolls back,
    // the content empties, the carried creation is rejected, and nothing stays proposed (the
    // content-less legacy batch included -- without that, the chat would report pending changes
    // forever).
    await impl.revertChanges(1, 0, USER);
    let meta = impl.storage.chatMeta.get(1)!;
    expect(meta.codeBase!.pins).toEqual([]);
    expect(meta.codeBase).toMatchObject({ generation: 1, revision: 0 });
    expect(impl.proposedChangeWorkpieceIds(1, meta)).toEqual([]);
    // The stale legacy flag the seed wrote is dead weight: derivation ignores it and delivery
    // strips it.
    let delivered = impl.chatMetaForClient(meta);
    expect(delivered.proposedChangeWorkpieces).toBeUndefined();
    expect(delivered.hasProposedChanges).toBeUndefined();
    expect(await gadgetContent(impl, 1, 1)).toEqual({});
    expect(impl.storage.gadgets.get(2)).toBeUndefined();
  }));

  it("allows a revert at the conversion boundary when no earlier batch is proposed",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);
    let boundary = seedConvertedChat(impl, c1, false);

    // Nothing before the boundary is proposed, so discarding from the boundary onward strands
    // nothing: the pin rolls back, the content empties, and the carried creation is rejected
    // (its re-stamped record falls in the reverted range) instead of lingering content-less.
    await impl.revertChanges(1, boundary, USER);
    let meta = impl.storage.chatMeta.get(1)!;
    expect(meta.codeBase!.pins).toEqual([]);
    expect(meta.codeBase).toMatchObject({ generation: 1, revision: 0 });
    expect(impl.proposedChangeWorkpieceIds(1, meta)).toEqual([]);
    expect(await gadgetContent(impl, 1, 1)).toEqual({});
    expect(impl.storage.gadgets.get(2)).toBeUndefined();
  }));
});

// The chat's pin for one gadget.
function pinOf(impl: any, chatId: number, gadgetId: number): any {
  return impl.storage.chatMeta.get(chatId)!.codeBase!.pins
      .find((pin: { gadgetId: number }) => pin.gadgetId === gadgetId);
}

// The chat's "changes" messages that record an update from mainline.
function mainlineMerges(impl: any, chatId: number): any[] {
  return chatMessages(impl, chatId)
      .filter(msg => msg.type === "changes" && msg.mainlineMerge !== undefined);
}

async function commitObject(impl: any, commitId: string) {
  return await impl.gitStore.readCommitObject(commitId);
}

async function filesAt(impl: any, commitId: string): Promise<Record<string, string>> {
  return Object.fromEntries(await impl.gitStore.readCommitFiles(commitId));
}

// A gadget at c1 and a chat that edited it, pinned there, with mainline since moved on to c2.
// (Each file the chat changes is submitted whole, which costs no diff however large it is.)
async function staleChat(impl: any, c1Files: Record<string, string>,
                         chatFiles: Record<string, string>, c2Files: Record<string, string>)
    : Promise<{ c1: string, c2: string }> {
  let c1 = await commitFiles(impl, c1Files);
  addGadget(impl, 1, "APP", c1);
  addChat(impl, 1);
  let entries: CodeChange[number] = Object.entries(chatFiles)
      .filter(([path, text]) => c1Files[path] !== text)
      .map(([path, text]) => [path, { set: text }]);
  await submit(impl, 1, {
    generation: 0, revision: 0, clientId: "cli", seq: 1,
    pins: [{ gadgetId: 1, baseCommit: c1 }],
    change: { 1: entries },
  });
  let c2 = await commitFiles(impl, c2Files, [c1]);
  setHead(impl, 1, c2);
  return { c1, c2 };
}

// Records an update from mainline as one from before merges were commits did: the merge as a
// change, the pin's mergedCommit advanced, and nothing declared.
async function updateAsBefore(impl: any, chatId: number, files: Record<string, string>)
    : Promise<number> {
  impl.materializeChatChanges(chatId);
  let change = editChange(1, await gadgetContent(impl, chatId, 1), files);
  let sequence = impl.nextChatSequence(chatId);
  impl.storage.chats.put({
    chatId, sequence, timestamp: impl.getChatTimestamp(), author: USER,
    type: "changes", change, mainlineMerge: { conflictPaths: [] },
  });
  let meta = impl.storage.chatMeta.get(chatId)!;
  meta.codeBase.pins.find((pin: { gadgetId: number }) => pin.gadgetId === 1).mergedCommit =
      impl.storage.gadgets.get(1)!.commitId;
  impl.storage.chatMeta.put(meta);
  impl.invalidateChatContent(chatId);
  return sequence;
}

describe("updateChatFromMainline", () => {
  const C1 = { "a.txt": "one\n" };
  const CHAT = { "a.txt": "one\nchat\n" };
  const C2 = { "a.txt": "one\n", "new.txt": "fresh\n" };
  const MERGED = { "a.txt": "one\nchat\n", "new.txt": "fresh\n" };

  it("commits the merge, re-roots the pin at it, and records the merge's commits",
      () => withImpl(async impl => {
    let { c1, c2 } = await staleChat(impl, C1, CHAT, C2);
    // An unpinned gadget whose mainline also moved is left alone: it tracks its head live.
    let d1 = await commitFiles(impl, { "b.txt": "bee\n" });
    addGadget(impl, 2, "OTHER", d1);
    setHead(impl, 2, await commitFiles(impl, { "b.txt": "changed\n" }, [d1]));

    expect(await impl.updateChatFromMainline(1, USER)).toEqual({ conflictPaths: [] });

    // The message records the merge as commits, not as a change.
    let [message] = mainlineMerges(impl, 1);
    expect(message.change).toBeUndefined();
    expect(message.watermark).toBeUndefined();
    let merge = message.pins[0].baseCommit;
    let snapshot = message.mainlineMerge.gadgets[0].chatCommit;
    expect(message.pins).toEqual([{ gadgetId: 1, baseCommit: merge, mergedCommit: c2 }]);
    expect(message.mainlineMerge).toEqual({
      conflictPaths: [],
      gadgets: [{ gadgetId: 1, baseCommit: c1, chatCommit: snapshot, conflictPaths: [] }],
    });

    // `S` holds the chat's files before the update, on the commit they were made on; `M` the
    // result, on mainline and then `S`.
    expect(await filesAt(impl, snapshot)).toEqual(CHAT);
    expect(await commitObject(impl, snapshot)).toMatchObject({
      parent: [c1], message: "Chat before update: Chat\n",
      author: { name: "Alice", email: "alice@example.com" },
    });
    expect(await filesAt(impl, merge)).toEqual(MERGED);
    expect(await commitObject(impl, merge)).toMatchObject({
      parent: [c2, snapshot], message: "Merge latest changes into chat: Chat\n",
      author: { name: "Alice", email: "alice@example.com" },
    });

    // The pin re-roots there, and the chat's content with it.
    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase.pins).toEqual([{ gadgetId: 1, baseCommit: merge, mergedCommit: c2 }]);
    expect(liveRows(impl, 1)).toEqual([]);
    expect(await gadgetContent(impl, 1, 1)).toEqual(MERGED);
    expect(await gadgetContent(impl, 1, 2)).toEqual({});

    // Accepted with no further edits, the merge commit is the gadget's head.
    expect(await impl.mergeChanges(1, USER_META, "user-do-id")).toEqual({ outcome: "merged" });
    expect(impl.storage.gadgets.get(1)!.commitId).toBe(merge);
  }));

  it("ends the change stream destructively, after delivering the message",
      () => withClient(async (impl, client) => {
    await staleChat(impl, C1, CHAT, C2);
    let events: string[] = [];
    let stub = new NativeRpcStub({
      onRpcBroken: () => {},
      streamGeneration: async () => {},
      metadata: async (meta: AiChatMetadata) => {
        events.push(`metadata ${meta.codeBase?.generation ?? 0}`);
      },
      deleted: async () => {},
      message: async (msg: AiChatMessage) => {
        if (msg.type === "changes" && msg.mainlineMerge) events.push("update message");
      },
      changeApplied: async () => { events.push("row"); },
      stream: async () => {},
    } as any) as unknown as RpcStub<AiChatSubscriber>;
    await client.subscribeToChat(stub);
    await settled();
    events.length = 0;

    await impl.withChatLock(1, () => impl.updateChatFromMainline(1, USER));
    await settled();
    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase).toMatchObject({ generation: 1, revision: 0 });
    expect(codeBase.prior).toBeUndefined();
    expect(events).not.toContain("row");
    expect(events.indexOf("update message")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("update message")).toBeLessThan(events.indexOf("metadata 1"));
  }));

  it("re-roots a chat with no changes of its own at the head, writing no commit",
      () => withImpl(async impl => {
    // The chat's edit nets out, so its files are the commit it pinned.
    let { c1, c2 } = await staleChat(impl, C1, CHAT, C2);
    await submit(impl, 1, {
      generation: 0, revision: 1, clientId: "cli", seq: 2, change: editChange(1, CHAT, C1),
    });
    impl.materializeChatChanges(1);
    let objects = [...impl.storage.gitObjects.list()].length;

    await impl.updateChatFromMainline(1, USER);
    expect([...impl.storage.gitObjects.list()].length).toBe(objects);
    let [message] = mainlineMerges(impl, 1);
    expect(message.pins).toEqual([{ gadgetId: 1, baseCommit: c2 }]);
    expect(message.mainlineMerge.gadgets)
        .toEqual([{ gadgetId: 1, baseCommit: c1, chatCommit: c1, conflictPaths: [] }]);
    expect(pinOf(impl, 1, 1)).toEqual({ gadgetId: 1, baseCommit: c2, mergedCommit: c2 });
    expect(await gadgetContent(impl, 1, 1)).toEqual(C2);

    expect(await impl.mergeChanges(1, USER_META, "user-do-id")).toEqual({ outcome: "merged" });
    expect(impl.storage.gadgets.get(1)!.commitId).toBe(c2);
  }));

  it("commits a merge where the chat made mainline's own change", () => withImpl(async impl => {
    let { c2 } = await staleChat(impl, C1, CHAT, CHAT);
    await impl.updateChatFromMainline(1, USER);
    let merge = pinOf(impl, 1, 1).baseCommit;
    expect((await commitObject(impl, merge)).parent[0]).toBe(c2);
    expect(await impl.gitStore.commitTree(merge)).toBe(await impl.gitStore.commitTree(c2));
    // The chat's files are then mainline's, so accepting has nothing to do.
    expect(await impl.mergeChanges(1, USER_META, "user-do-id")).toEqual({ outcome: "merged" });
    expect(impl.storage.gadgets.get(1)!.commitId).toBe(c2);
  }));

  it("snapshots a chat updated before on the earlier update's merge commit",
      () => withImpl(async impl => {
    let { c2 } = await staleChat(impl, C1, CHAT, C2);
    await impl.updateChatFromMainline(1, USER);
    let first = pinOf(impl, 1, 1).baseCommit;

    let edited = { ...MERGED, "a.txt": "one\nchat\nmore\n" };
    await submit(impl, 1, {
      generation: 1, revision: 0, clientId: "cli2", seq: 1, change: editChange(1, MERGED, edited),
    });
    let c3 = await commitFiles(impl, { ...C2, "c.txt": "sea\n" }, [c2]);
    setHead(impl, 1, c3);
    await impl.updateChatFromMainline(1, USER);

    let [, message] = mainlineMerges(impl, 1);
    let [{ baseCommit, chatCommit }] = message.mainlineMerge.gadgets;
    expect(baseCommit).toBe(c2);
    expect((await commitObject(impl, chatCommit)).parent).toEqual([first]);
    expect(await filesAt(impl, chatCommit)).toEqual(edited);
    let second = pinOf(impl, 1, 1).baseCommit;
    expect((await commitObject(impl, second)).parent).toEqual([c3, chatCommit]);
    expect(await filesAt(impl, second)).toEqual({ ...edited, "c.txt": "sea\n" });
  }));

  it("records conflicts, by gadget and by path within it", () => withImpl(async impl => {
    let { c1, c2 } = await staleChat(impl, C1, CHAT, { "a.txt": "one\nmain\n" });
    expect(await impl.updateChatFromMainline(1, USER))
        .toEqual({ conflictPaths: ["APP/a.txt"] });
    let [message] = mainlineMerges(impl, 1);
    expect(message.mainlineMerge).toEqual({
      conflictPaths: ["APP/a.txt"],
      gadgets: [{ gadgetId: 1, baseCommit: c1, chatCommit: expect.any(String),
                  conflictPaths: ["a.txt"] }],
    });
    expect((await gadgetContent(impl, 1, 1))["a.txt"]).toBe(
        "one\n<<<<<<< mainline\nmain\n||||||| merged base\n=======\nchat\n>>>>>>> this chat\n");
    expect(pinOf(impl, 1, 1).mergedCommit).toBe(c2);
  }));

  it("can be reverted, which makes the chat stale again", () => withImpl(async impl => {
    let { c1, c2 } = await staleChat(impl, C1, CHAT, C2);
    await impl.updateChatFromMainline(1, USER);
    let [message] = mainlineMerges(impl, 1);

    await impl.revertChanges(1, message.sequence, USER);
    expect(pinOf(impl, 1, 1)).toEqual({ gadgetId: 1, baseCommit: c1, mergedCommit: c1 });
    expect(await gadgetContent(impl, 1, 1)).toEqual(CHAT);
    expect(await impl.mergeChanges(1, USER_META, "user-do-id")).toEqual({ outcome: "stale" });

    // And updated again, it merges as the first time.
    await impl.updateChatFromMainline(1, USER);
    expect(pinOf(impl, 1, 1).mergedCommit).toBe(c2);
    expect(await gadgetContent(impl, 1, 1)).toEqual(MERGED);
  }));

  it("merges against what an update from before merges were commits brought in, after a revert",
      () => withImpl(async impl => {
    // The chat is brought up to date with c2's change to b.txt by an update of the old form.
    let c1Files = { "a.txt": "one\n", "b.txt": "bee\n" };
    let chatFiles = { "a.txt": "one\nchat\n", "b.txt": "bee\n" };
    let c2Files = { "a.txt": "one\n", "b.txt": "bee two\n" };
    let { c1, c2 } = await staleChat(impl, c1Files, chatFiles, c2Files);
    await updateAsBefore(impl, 1, { "a.txt": "one\nchat\n", "b.txt": "bee two\n" });
    expect(pinOf(impl, 1, 1)).toEqual({ gadgetId: 1, baseCommit: c1, mergedCommit: c2 });

    // Mainline then undoes that change. An update of the new form, reverted, leaves the pin as
    // the old one had put it.
    let c3 = await commitFiles(impl, { ...c1Files, "c.txt": "sea\n" }, [c2]);
    setHead(impl, 1, c3);
    await impl.updateChatFromMainline(1, USER);
    let [, update] = mainlineMerges(impl, 1);
    expect(update.mainlineMerge.gadgets[0].baseCommit).toBe(c2);
    await impl.revertChanges(1, update.sequence, USER);
    expect(pinOf(impl, 1, 1)).toEqual({ gadgetId: 1, baseCommit: c1, mergedCommit: c2 });

    // So the next update takes mainline's undo. Merged against c1, it would have kept the
    // chat's copy of b.txt as an edit of its own, and reported no conflict.
    expect(await impl.updateChatFromMainline(1, USER)).toEqual({ conflictPaths: [] });
    expect(await gadgetContent(impl, 1, 1))
        .toEqual({ "a.txt": "one\nchat\n", "b.txt": "bee\n", "c.txt": "sea\n" });
  }));

  it("still refuses to revert an update from before merges were commits",
      () => withImpl(async impl => {
    await staleChat(impl, C1, CHAT, C2);
    let sequence = await updateAsBefore(impl, 1, MERGED);
    await expect(impl.revertChanges(1, sequence, USER)).rejects.toThrow(/update from mainline/);
  }));

  it("a gadget with no code pins at its empty-tree head and merges like any other",
      () => withImpl(async impl => {
    // Every permanent gadget has a head -- an empty-tree commit before it has code (see
    // GadgetRecord.commitId) -- so a chat's first edit always has a commit to pin, and losing
    // the race to the gadget's first real content is the ordinary stale/update/retry flow.
    let e0 = await commitFiles(impl, {});
    addGadget(impl, 1, "APP", e0);
    addChat(impl, 1);

    // The first edit pins at the empty tree.
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: e0 }],
      change: { 1: [["a.txt", { set: "chat\n" }]] },
    });

    // Another chat wins the race to the gadget's first real content.
    let c1 = await commitFiles(impl, { "b.txt": "mainline\n" }, [e0]);
    setHead(impl, 1, c1);

    // The chat can no longer fast-forward...
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "stale" });

    // ...but the normal pinned path covers it: a 3-way merge whose base is the pinned empty
    // tree, re-rooting the pin at the merge.
    let { conflictPaths } = await impl.updateChatFromMainline(1, USER);
    expect(conflictPaths).toEqual([]);
    let merge = pinOf(impl, 1, 1).baseCommit;
    expect(pinOf(impl, 1, 1)).toEqual({ gadgetId: 1, baseCommit: merge, mergedCommit: c1 });
    expect(await gadgetContent(impl, 1, 1)).toEqual({
      "a.txt": "chat\n",
      "b.txt": "mainline\n",
    });

    // The accept fast-forwards to the merge.
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    expect(impl.storage.gadgets.get(1)!.commitId).toBe(merge);
    expect((await commitObject(impl, merge)).parent[0]).toBe(c1);
  }));

  describe("refuses a merge that needs a file too large to hold", () => {
    // A file of 200K characters, whose every line both sides change: the conflict holds all
    // three versions, 600K characters in all, which is more than a file may.
    const lines = (word: string) => `${word.repeat(250)}\n`.repeat(200);
    // Under the text limit, but a blob of more than 1 MiB: each "€" takes three bytes.
    const wide = `${"€".repeat(399)}\n`.repeat(1000);

    async function expectRefused(impl: any, pattern: RegExp): Promise<void> {
      impl.materializeChatChanges(1);
      let before = { meta: impl.storage.chatMeta.get(1), messages: chatMessages(impl, 1) };
      await expect(impl.updateChatFromMainline(1, USER)).rejects.toThrow(pattern);
      expect(impl.storage.chatMeta.get(1)).toEqual(before.meta);
      expect(chatMessages(impl, 1)).toEqual(before.messages);
    }

    it("where the merged text would be", () => withImpl(async impl => {
      await staleChat(impl, { "big.txt": lines("base") }, { "big.txt": lines("chat") },
                      { "big.txt": lines("main") });
      await expectRefused(impl, /Cannot merge "APP\/big\.txt".*undo this chat's changes to it/);
    }));

    it("where one side's blob is", () => withImpl(async impl => {
      await staleChat(impl, { "big.txt": "base\n" }, { "big.txt": "chat\n" },
                      { "big.txt": wide });
      await expectRefused(impl, /Cannot merge "APP\/big\.txt"/);
    }));

    it("but not where only one side changed the file", () => withImpl(async impl => {
      let c1Files = { "big.txt": "base\n", "a.txt": "one\n" };
      await staleChat(impl, c1Files, { ...c1Files, "a.txt": "one\nchat\n" },
                      { ...c1Files, "big.txt": wide });
      expect(await impl.updateChatFromMainline(1, USER)).toEqual({ conflictPaths: [] });
      expect(await gadgetContent(impl, 1, 1))
          .toEqual({ "big.txt": wide, "a.txt": "one\nchat\n" });
    }));
  });
});

describe("agent step barrier", () => {
  // The step's chat messages as the turn_end barrier would hand them over.
  function stepMsgs(text: string): { type: "message", message: string }[] {
    return [{ type: "message", message: text }];
  }
  const NO_EXTRAS = {
    createdGadgets: [], createdWorktrees: [], addedBindings: [], worktreeCommits: [],
  };

  it("persists the step message, appends rows in order, and materializes -- one transaction",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    expect(await impl.commitAgentStep(1, AGENT, stepMsgs("wrote files"), {
      ...NO_EXTRAS,
      changes: [
        { change: { 1: [["a.txt", { set: "one\nagent\n" }]] },
          pin: { gadgetId: 1, baseCommit: c1 } },
        { change: { 1: [["b.txt", { set: "bee\n" }]] } },
      ],
    })).toBe(true);

    // Ordering: the tool-call message precedes the step's single "changes" message, so a
    // suffix revert can never erase the call while keeping its edits.
    let msgs = chatMessages(impl, 1);
    expect(msgs.map(msg => msg.type)).toEqual(["message", "changes"]);
    expect(msgs[1].author).toEqual(AGENT);
    expect(msgs[1].pins).toEqual([{ gadgetId: 1, baseCommit: c1 }]);
    expect(msgs[1].watermark).toEqual({ changesGeneration: 0, throughRevision: 2 });

    // One row per buffered change, in call order, born retired (live only inside the barrier);
    // the pin was validated and mirrored with its row.
    let rows = [...impl.storage.chatChanges.list({ prefix: `${keyString(1)}.` })];
    expect(rows.map((row: any) => [row.revision, row.author.type, row.retired]))
        .toEqual([[1, "agent", true], [2, "agent", true]]);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toEqual(
        [{ gadgetId: 1, baseCommit: c1, mergedCommit: c1 }]);
    expect(impl.undeclaredMetaPins(1, impl.storage.chatMeta.get(1)!)).toEqual([]);
    expect(await gadgetContent(impl, 1, 1)).toEqual(
        { "a.txt": "one\nagent\n", "b.txt": "bee\n" });

    // A changeless step persists its message but writes no "changes" message (the agent's
    // change-ID numbering counts messages, so the false return keeps the counter in step).
    expect(await impl.commitAgentStep(1, AGENT, stepMsgs("just talk"),
        { ...NO_EXTRAS, changes: [] })).toBe(false);
    expect(chatMessages(impl, 1).map(msg => msg.type))
        .toEqual(["message", "changes", "message"]);
  }));

  it("writes the step's buffer as one message even past the message byte budget",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    // Two buffered changes composing to ~1.2MB by the serialized-size estimate: past
    // CHAT_CHANGE_MESSAGE_BUDGET (the *user* path's accumulation bound) but within the step
    // budget the write calls enforce. The barrier still writes exactly one message -- the
    // no-chunking policy; the step's bound is what keeps this storable.
    let text = "文".repeat(300_000);
    expect(await impl.commitAgentStep(1, AGENT, stepMsgs("big step"), {
      ...NO_EXTRAS,
      changes: [
        { change: { 1: [["a.txt", { set: text }]] }, pin: { gadgetId: 1, baseCommit: c1 } },
        { change: { 1: [["b.txt", { set: text }]] } },
      ],
    })).toBe(true);

    let changes = chatMessages(impl, 1).filter(msg => msg.type === "changes");
    expect(changes).toHaveLength(1);
    expect(changes[0].watermark).toEqual({ changesGeneration: 0, throughRevision: 2 });
    expect(liveRows(impl, 1)).toHaveLength(0);

    let folded = await impl.buildChatContent(1);
    expect(["a.txt", "b.txt"].map(file => folded.get(1)!.get(file))).toEqual([text, text]);
  }));

  it("a mid-barrier failure leaves no partial durable state and the chat stays usable",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    // The second buffered change fails content validation after the first already appended its
    // row (and broadcast it): the transaction must roll back the row, the pin mirror, and the
    // step's messages together -- a partial step is exactly the state this barrier exists to
    // make impossible.
    await expect(impl.commitAgentStep(1, AGENT, stepMsgs("doomed"), {
      ...NO_EXTRAS,
      changes: [
        { change: { 1: [["a.txt", { set: "one\nagent\n" }]] },
          pin: { gadgetId: 1, baseCommit: c1 } },
        { change: { 1: [["a.txt", { edit: [2, [2, "x"], 96] }]] } },  // expects a 100-unit file
      ],
    })).rejects.toThrow(/length mismatch/);

    expect(chatMessages(impl, 1)).toEqual([]);
    expect([...impl.storage.chatChanges.list({ prefix: `${keyString(1)}.` })]).toEqual([]);
    expect(impl.storage.chatMeta.get(1)!.codeBase?.pins ?? []).toEqual([]);
    expect(await gadgetContent(impl, 1, 1)).toEqual({});

    // The in-memory content/byte caches were dropped with the rollback: a subsequent barrier
    // starts from revision 0 as if the failed one never happened.
    expect(await impl.commitAgentStep(1, AGENT, stepMsgs("retried"), {
      ...NO_EXTRAS,
      changes: [{ change: { 1: [["a.txt", { set: "one\nagent\n" }]] },
                  pin: { gadgetId: 1, baseCommit: c1 } }],
    })).toBe(true);
    expect(chatMessages(impl, 1).find(msg => msg.type === "changes")!.watermark)
        .toEqual({ changesGeneration: 0, throughRevision: 1 });
    expect(await gadgetContent(impl, 1, 1)).toEqual({ "a.txt": "one\nagent\n" });
  }));

  it("a pin whose base is no longer the head fails the barrier with no durable trace",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1]);
    addGadget(impl, 1, "APP", c2);
    addChat(impl, 1);

    // Mainline moved between the tool call (which anchored at c2) and the barrier.
    setHead(impl, 1, c1);
    await expect(impl.commitAgentStep(1, AGENT, stepMsgs("stale pin"), {
      ...NO_EXTRAS,
      changes: [{ change: { 1: [["a.txt", { set: "x" }]] },
                  pin: { gadgetId: 1, baseCommit: c2 } }],
    })).rejects.toThrow(/no longer the gadget's head/);
    expect(chatMessages(impl, 1)).toEqual([]);
    expect([...impl.storage.chatChanges.list({ prefix: `${keyString(1)}.` })]).toEqual([]);
  }));

  it("stamps a pending gadget creation with the step's changes message",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let created = impl.createGadget("My Gadget", "MY_GADGET", 1);
    // The record is created (and its name reserved) mid-step, unstamped until the barrier.
    expect(impl.storage.gadgets.get(created.id)!.pending).toEqual({ chatId: 1 });

    expect(await impl.commitAgentStep(1, AGENT, stepMsgs("created a gadget"), {
      changes: [{ change: { [created.id]: [["main.js", { set: "code\n" }]] } }],
      createdGadgets: [
        { gadgetId: created.id, title: created.title, bindingName: "MY_GADGET" }],
      createdWorktrees: [],
      addedBindings: [],
      worktreeCommits: [],
    })).toBe(true);

    // The stamp is the changes message's sequence: the durable record merge/revert compare
    // against, written in the same transaction as the message itself.
    let changes = chatMessages(impl, 1).find(msg => msg.type === "changes")!;
    expect(changes.createdGadgets).toEqual(
        [{ gadgetId: created.id, title: created.title, bindingName: "MY_GADGET" }]);
    expect(impl.storage.gadgets.get(created.id)!.pending)
        .toEqual({ chatId: 1, sequence: changes.sequence });
  }));

});

describe("reconcilePendingGadgets", () => {
  it("reaps unstamped records and edges regardless of what the log holds (no vouching)",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    // Simulate a mid-step crash: the createGadget/setGadgetBinding tools ran (registry record
    // created and name reserved, edge added) but the step never reached its barrier, so both
    // are unstamped.
    let created = impl.createGadget("Doomed", "DOOMED", 1);
    let gadget1 = impl.storage.gadgets.get(1)!;
    gadget1.bindings["FOO"] = { target: 99, pending: { chatId: 1 } };
    impl.storage.gadgets.put(gadget1);

    // The old recovery scanned the log for persisted tool calls that "vouch" for an orphan,
    // sparing it for replay to re-adopt. Barrier atomicity inverted that: a persisted call
    // implies a persisted stamp, so an unstamped record is a mid-step crash orphan no matter
    // what the log holds -- even a message referencing it (which, post-barrier, can only be
    // corrupt or pre-barrier history) must not resurrect it.
    impl.addChatMessages(1, AGENT, [{
      type: "message", message: "creating",
      toolCalls: [
        { toolCallId: "t1", toolName: "createGadget",
          input: { title: "Doomed", bindingName: "DOOMED" },
          output: { gadgetId: created.id, changeId: 1 } },
        { toolCallId: "t2", toolName: "setGadgetBinding",
          input: { gadget: "APP", source: "FOO" },
          output: { gadgetId: 1, name: "FOO", target: 99, changeId: 1 } },
      ],
    }]);

    await impl.reconcilePendingGadgets(1);
    expect(impl.storage.gadgets.get(created.id)).toBeUndefined();
    expect(impl.storage.gadgets.get(1)!.bindings).toEqual({});
  }));

  it("removes a stamped record once the log marks its creation reverted",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let created = impl.createGadget("My Gadget", "MY_GADGET", 1);
    await impl.commitAgentStep(1, AGENT, [{ type: "message", message: "created a gadget" }], {
      changes: [{ change: { [created.id]: [["main.js", { set: "code\n" }]] } }],
      createdGadgets: [
        { gadgetId: created.id, title: created.title, bindingName: "MY_GADGET" }],
      createdWorktrees: [],
      addedBindings: [],
      worktreeCommits: [],
    });
    let stamp = impl.storage.gadgets.get(created.id)!.pending!.sequence!;

    // A stamped record is untouched while its creation stands...
    await impl.reconcilePendingGadgets(1);
    expect(impl.storage.gadgets.get(created.id)).toBeDefined();

    // ...but once a revert message covers the stamp, reconciliation removes it. (Simulates a
    // revert that recorded its message and then crashed before the awaited record deletions --
    // reverts record first, see #revertChanges -- making reconciliation the recovery.)
    impl.storage.chats.put({
      chatId: 1, sequence: impl.nextChatSequence(1), timestamp: impl.getChatTimestamp(),
      author: USER, type: "revert", revertFrom: stamp,
    });
    await impl.reconcilePendingGadgets(1);
    expect(impl.storage.gadgets.get(created.id)).toBeUndefined();
  }));
});

describe("chat content reconstruction", () => {
  it("buildChatContent(through) reconstructs as of that sequence, before a later boundary",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "one\nchat\n" }),
    });
    let materialized = impl.materializeChatChanges(1)!;

    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });

    // As of `through` the merge hadn't happened: its epoch boundary must not wipe the
    // snapshot it postdates.
    let content = await impl.buildChatContent(1, materialized.sequence);
    expect(Object.fromEntries(content.get(1)!)).toEqual({ "a.txt": "one\nchat\n" });
    // ...while the current fold starts fresh at the boundary.
    expect((await impl.buildChatContent(1)).get(1)).toBeUndefined();
  }));

  it("materializes automatically when the live window grows past the threshold",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "0\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    let text = "0\n";
    for (let i = 1; i <= 1001; i++) {
      let next = `${i}\n${text}`;
      await submit(impl, 1, {
        generation: 0, revision: i - 1, clientId: "cli", seq: i,
        ...(i === 1 ? { pins: [{ gadgetId: 1, baseCommit: c1 }] } : {}),
        change: editChange(1, { "a.txt": text }, { "a.txt": next }),
      });
      text = next;
    }

    // The 1000-row window was materialized into a single "changes" message; the stream keeps
    // counting.
    let changes = chatMessages(impl, 1).filter(msg => msg.type === "changes");
    expect(changes).toHaveLength(1);
    expect(changes[0].watermark).toEqual({ changesGeneration: 0, throughRevision: 1000 });
    expect(liveRows(impl, 1)).toHaveLength(1);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.revision).toBe(1001);
    expect((await gadgetContent(impl, 1, 1))["a.txt"]).toBe(text);
  }));

  it("materializes the pending window before a submission would breach the byte budget",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    // Two rows setting *distinct* files (so their composition genuinely accumulates payload
    // rather than collapsing), each 300K two-byte characters = ~600KB by the serialized-size
    // estimate (hand-built `set` changes: diffing dissimilar strings this large is quadratic).
    // Together they compose past the 1MB byte budget, so the second submission must materialize
    // the first row into its own message before appending.
    let text = "文".repeat(300_000);
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: { 1: [["a.txt", { set: text }]] },
    });
    expect(chatMessages(impl, 1).filter(msg => msg.type === "changes")).toHaveLength(0);

    await submit(impl, 1, {
      generation: 0, revision: 1, clientId: "cli", seq: 2,
      change: { 1: [["b.txt", { set: text }]] },
    });
    let changes = chatMessages(impl, 1).filter(msg => msg.type === "changes");
    expect(changes).toHaveLength(1);
    expect(changes[0].pins).toEqual([{ gadgetId: 1, baseCommit: c1 }]);
    expect(changes[0].watermark).toEqual({ changesGeneration: 0, throughRevision: 1 });
    expect(liveRows(impl, 1)).toHaveLength(1);

    // A materialize call writes exactly one message covering the remaining row.
    impl.materializeChatChanges(1);
    changes = chatMessages(impl, 1).filter(msg => msg.type === "changes");
    expect(changes).toHaveLength(2);
    expect(changes[1].watermark).toEqual({ changesGeneration: 0, throughRevision: 2 });
    expect(changes[1].pins).toBeUndefined();
    expect(liveRows(impl, 1)).toHaveLength(0);

    // The split log folds to the same content a single message would have.
    let folded = await impl.buildChatContent(1);
    expect(["a.txt", "b.txt"].map(file => folded.get(1)!.get(file))).toEqual([text, text]);
  }));

  it("a change bigger than the whole budget travels alone in one oversized message",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    // One row -- a single multi-file change of two 300K-two-byte-character files, ~1.2MB by the
    // serialized-size estimate -- exceeds the 1MB budget on its own while staying inside the
    // per-file and per-change caps. It appends into an empty window; the next submission's byte
    // trigger then materializes it alone, in one message.
    let big = "文".repeat(300_000);
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: { 1: [["a.txt", { set: big }], ["b.txt", { set: big }]] },
    });
    await submit(impl, 1, {
      generation: 0, revision: 1, clientId: "cli", seq: 2,
      change: { 1: [["c.txt", { set: "small\n" }]] },
    });

    let changes = chatMessages(impl, 1).filter(msg => msg.type === "changes");
    expect(changes).toHaveLength(1);
    expect(changes[0].watermark).toEqual({ changesGeneration: 0, throughRevision: 1 });
    expect(liveRows(impl, 1)).toHaveLength(1);
    expect((await gadgetContent(impl, 1, 1))["a.txt"]).toBe(big);
    expect((await gadgetContent(impl, 1, 1))["b.txt"]).toBe(big);
  }));

  it("splits batches by author when a different author resumes after idle",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "alice", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "one\nalice\n" }),
    });
    // Age Alice's row past the split threshold, then Bob types.
    for (let row of Array.from(impl.storage.chatChanges.list({ prefix: `${keyString(1)}.` }))) {
      (row as any).timestamp = new Date(Date.now() - 2 * 60_000);
      impl.storage.chatChanges.put(row);
    }
    await submit(impl, 1, {
      generation: 0, revision: 1, clientId: "bob", seq: 1,
      change: editChange(1, { "a.txt": "one\nalice\n" }, { "a.txt": "one\nalice\nbob\n" }),
    }, BOB, "bob-user-do");

    // Alice's batch was materialized under her name before Bob's row landed.
    let changes = chatMessages(impl, 1).filter(msg => msg.type === "changes");
    expect(changes).toHaveLength(1);
    expect(changes[0].author).toEqual(USER);
    expect(changes[0].watermark).toEqual({ changesGeneration: 0, throughRevision: 1 });
    expect(liveRows(impl, 1)).toHaveLength(1);
  }));
});

describe("proposed-changes derivation", () => {
  // proposedChangeWorkpieceIds derives per-workpiece proposed-ness from the chat's pins and the
  // registry's pending records/edges -- there is no cached flag to drift. Worktree-side coverage
  // (worktree pins and creations never propose) lives in worktrees.test.ts.

  function derived(impl: any, chatId: number): number[] {
    return impl.proposedChangeWorkpieceIds(chatId, impl.storage.chatMeta.get(chatId)!);
  }

  it("derives from pins: only the touched gadget proposes, and accept clears it",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let c2 = await commitFiles(impl, { "b.txt": "two\n" });
    addGadget(impl, 1, "APP", c1);
    addGadget(impl, 2, "OTHER", c2);
    addChat(impl, 1);
    expect(derived(impl, 1)).toEqual([]);

    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "xone\n" }),
    });
    // The untouched gadget 2 stays out: it must keep loading as its mainline self even while
    // this chat proposes changes elsewhere (see getGadgetFacetFetcher). Delivery carries the
    // same list.
    expect(derived(impl, 1)).toEqual([1]);
    expect(impl.chatMetaForClient(impl.storage.chatMeta.get(1)!).proposedChangeWorkpieces)
        .toEqual([1]);

    expect(await impl.mergeChanges(1, USER_META, "user-do-id")).toEqual({ outcome: "merged" });
    expect(derived(impl, 1)).toEqual([]);
    expect(impl.chatMetaForClient(impl.storage.chatMeta.get(1)!).proposedChangeWorkpieces)
        .toBeUndefined();
  }));

  it("counts pending creations and pending binding edges, scoped to their chat",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);
    // (Distinct lastActive: chatMeta.byLastActive is a unique index.)
    impl.storage.chatMeta.put(
        { id: 2, title: "Chat 2", started: new Date(0), lastActive: new Date(1) });

    // A provisional creation in chat 1, and a provisional binding edge on gadget 1 added by
    // chat 2 (seeded directly; only the edge's pending stamp matters here). A binding addition
    // changes the gadget's env without touching its code, so it must count.
    let created = impl.createGadget("Mine", "MINE", 1);
    let app = impl.storage.gadgets.get(1)!;
    app.bindings["GK"] = { target: 999, pending: { chatId: 2 } };
    impl.storage.gadgets.put(app);

    expect(derived(impl, 1)).toEqual([created.id]);
    expect(derived(impl, 2)).toEqual([1]);
  }));

  it("a revert re-broadcasts derived metadata after reaping the doomed creation",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);
    let created = impl.createGadget("Mine", "MINE", 1);
    // Record the creation so the pending record gets sequence-stamped.
    impl.materializeChatChanges(1, undefined, { author: USER, createdGadgets: [
      { gadgetId: created.id, title: "Mine", bindingName: "MINE" },
    ]});
    expect(derived(impl, 1)).toEqual([created.id]);

    let deliveredLists: (number[] | undefined)[] = [];
    impl.storage.chatMeta.subscribe({
      add: () => {},
      update: (_old: unknown, next: unknown) => {
        deliveredLists.push(impl.chatMetaForClient(next).proposedChangeWorkpieces);
      },
      remove: () => {},
    });

    // The revert's own meta write precedes the awaited record reap (see #revertChanges on why
    // that order is fixed), so reconciliation must re-put the metadata afterwards: the *last*
    // broadcast a subscriber saw has to reflect the post-reap state, or the client keeps
    // offering accept/discard for a chat that proposes nothing.
    await impl.revertChanges(1, 0, USER);
    expect(impl.storage.gadgets.get(created.id)).toBeUndefined();
    expect(derived(impl, 1)).toEqual([]);
    expect(deliveredLists.length).toBeGreaterThan(0);
    expect(deliveredLists.at(-1)).toBeUndefined();
  }));
});
