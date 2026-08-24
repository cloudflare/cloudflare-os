import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AiChatAuthorInfo, AiChatMessage, CodeChangeSubmission,
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
// straggler bridge, update-from-mainline as a change row, and destructive bumps (revert / draft
// discard) -- against the real OverseerImpl running in workerd, over real storage and a real git
// object store. Each test gets a fresh DO.

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

function addGadget(impl: any, id: number, bindingName: string, commitId?: string): void {
  impl.storage.gadgets.put({
    id, title: bindingName, created: new Date(0), bindingName, bindings: {},
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

  it("accepts a pin at the head's parent but rejects older bases", () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1]);
    let c3 = await commitFiles(impl, { "a.txt": "three\n" }, [c2]);
    addGadget(impl, 1, "APP", c3);
    addChat(impl, 1);

    await expect(submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli-a", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "xone\n" }),
    })).rejects.toThrow(/does not match the gadget's current head/);

    // A parent of the head is tolerated: the client raced exactly one merge.
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli-b", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c2 }],
      change: editChange(1, { "a.txt": "two\n" }, { "a.txt": "xtwo\n" }),
    });
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins[0].baseCommit).toBe(c2);
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

  it("transforms concurrent submissions so both sides' edits survive",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "middle\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    // Both clients build against revision 0. Alice's lands first; Bob's is transformed over it.
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "alice", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "middle\n" }, { "a.txt": "top\nmiddle\n" }),
    });
    let ack = await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "bob", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "middle\n" }, { "a.txt": "middle\nbottom\n" }),
    }, BOB, "bob-user-do");
    expect(ack).toEqual({ generation: 0, revision: 2 });

    expect(await gadgetContent(impl, 1, 1)).toEqual({ "a.txt": "top\nmiddle\nbottom\n" });
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

  it("rejects submissions while an agent turn is active", () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);
    let meta = impl.storage.chatMeta.get(1)!;
    meta.activeAgent = AGENT;
    impl.storage.chatMeta.put(meta);

    await expect(submit(impl, 1, {
      generation: 0, revision: 0, clientId: "c1", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "xone\n" }),
    })).rejects.toThrow(/Agent is running/);
  }));
});

describe("submitCodeChange dedupe", () => {
  it("acknowledges a retry with its recorded landing spot without re-applying",
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
    expect(await submit(impl, 1, submission)).toEqual(ack);  // retry: same spot, no re-apply
    expect(liveRows(impl, 1)).toHaveLength(1);
    expect(await gadgetContent(impl, 1, 1)).toEqual({ "a.txt": "xone\n" });

    // A same-seq submission with different content is a client bug, rejected loudly.
    await expect(submit(impl, 1, {
      ...submission,
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "yone\n" }),
    })).rejects.toThrow(/different content/);

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
    expect(impl.getProposedChanges(1)).toEqual([]);
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

  it("returns stale when mainline moved past a pin, with no partial effects",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "mine\none\n" }),
    });

    // Another chat's accept advances the head.
    let c2 = await commitFiles(impl, { "a.txt": "theirs\n" }, [c1]);
    setHead(impl, 1, c2);

    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "stale" });
    expect(impl.storage.gadgets.get(1)!.commitId).toBe(c2);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.generation).toBe(0);
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

    // Mainline moves on gadget 2, but this time the chat updates from mainline first: the
    // merge change brings the chat's gadget-2 content to d2's tree and advances mergedCommit to d2
    // (baseCommit stays d1 -- immutable). The pin is then content-equal to head at the reset.
    let d2 = await commitFiles(impl, { "b.txt": "changed\n" }, [d1]);
    setHead(impl, 2, d2);
    let { conflictPaths } = await impl.updateChatFromMainline(1, USER);
    expect(conflictPaths).toEqual([]);
    expect(await gadgetContent(impl, 1, 2)).toEqual({ "b.txt": "changed\n" });

    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    let prior = impl.storage.chatMeta.get(1)!.codeBase!.prior!;
    expect(prior.discontinuousGadgets).toEqual([]);

    // A straggler touching gadget 2 -- expressed against d2's content, which carried across by
    // identity -- bridges cleanly and pins gadget 2 at its boundary commit (head d2).
    let finalRevision = prior.finalRevision;
    let ack = await submit(impl, 1, {
      generation: 0, revision: finalRevision, clientId: "typist", seq: 4,
      change: editChange(2, { "b.txt": "changed\n" }, { "b.txt": "changed\nmore\n" }),
    });
    expect(ack).toEqual({ generation: 1, revision: 1 });
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

  it("does not bridge across a destructive bump", () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "typist", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "one\nedited\n" }),
    });
    impl.discardChatDraftChanges(1);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.prior).toBeUndefined();

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

  // Seeds the shape the git-storage migration leaves behind (see git-migration.ts): legacy
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
      id: 2, title: "Mine", created: new Date(0), bindingName: "MINE", bindings: {},
      pending: { chatId: 1, sequence: boundary },
    });
    let meta = impl.storage.chatMeta.get(1)!;
    meta.codeBase = {
      pins: [{ gadgetId: 1, baseCommit: c1, mergedCommit: c1 }],
      generation: 0, epoch: boundary, revision: 0,
    };
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
    expect(meta.hasProposedChanges).toBeUndefined();
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
    expect(meta.hasProposedChanges).toBeUndefined();
    expect(await gadgetContent(impl, 1, 1)).toEqual({});
    expect(impl.storage.gadgets.get(2)).toBeUndefined();
  }));
});

describe("updateChatFromMainline", () => {
  it("merges only pinned-and-behind gadgets as a change row, and its batch cannot be reverted",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let d1 = await commitFiles(impl, { "b.txt": "bee\n" });
    addGadget(impl, 1, "APP", c1);
    addGadget(impl, 2, "OTHER", d1);
    addChat(impl, 1);

    // Pin gadget 1 with an edit; leave gadget 2 unpinned.
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "one\nchat\n" }),
    });

    // Mainline advances on both gadgets.
    let c2 = await commitFiles(impl, { "a.txt": "one\n", "new.txt": "fresh\n" }, [c1]);
    setHead(impl, 1, c2);
    let d2 = await commitFiles(impl, { "b.txt": "changed\n" }, [d1]);
    setHead(impl, 2, d2);

    let { conflictPaths } = await impl.updateChatFromMainline(1, USER);
    expect(conflictPaths).toEqual([]);

    // The pinned gadget merged (delivered as a row and re-recorded in a mainlineMerge
    // message); the unpinned gadget was left alone -- it tracks head live, no pin created.
    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase.pins).toHaveLength(1);
    expect(codeBase.pins[0]).toMatchObject({ gadgetId: 1, baseCommit: c1, mergedCommit: c2 });
    expect(await gadgetContent(impl, 1, 1)).toEqual({
      "a.txt": "one\nchat\n",
      "new.txt": "fresh\n",
    });
    expect(await gadgetContent(impl, 1, 2)).toEqual({});

    let mainlineBatch = chatMessages(impl, 1)
        .find(msg => msg.type === "changes" && msg.mainlineMerge !== undefined)!;
    expect(mainlineBatch.change).toBeDefined();
    expect(mainlineBatch.watermark).toEqual({ changesGeneration: 0, throughRevision: 2 });

    // The still-proposed mainline-merge batch cannot be reverted: it advanced the pin.
    await expect(impl.revertChanges(1, mainlineBatch.sequence, USER))
        .rejects.toThrow(/update from mainline/);
  }));

  it("records the advancement even when the chat's content already matched mainline",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    // Pin with an edit that nets out to mainline's own future content.
    await submit(impl, 1, {
      generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{ gadgetId: 1, baseCommit: c1 }],
      change: editChange(1, { "a.txt": "one\n" }, { "a.txt": "one\nsame\n" }),
    });
    let c2 = await commitFiles(impl, { "a.txt": "one\nsame\n" }, [c1]);
    setHead(impl, 1, c2);

    let { conflictPaths } = await impl.updateChatFromMainline(1, USER);
    expect(conflictPaths).toEqual([]);

    // No change to deliver (content already matched), but the message durably records the pin
    // advancement the revert restriction keys on.
    let mainlineBatch = chatMessages(impl, 1)
        .find(msg => msg.type === "changes" && msg.mainlineMerge !== undefined)!;
    expect(mainlineBatch.change).toBeUndefined();
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins[0].mergedCommit).toBe(c2);

    // And the accept now fast-forwards... to nothing: the chat's content equals head, so there
    // is nothing to commit and the merge is a no-op accept of the mainline-merge batch.
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    expect(impl.storage.gadgets.get(1)!.commitId).toBe(c2);
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
    // tree, advancing the pin to head.
    let { conflictPaths } = await impl.updateChatFromMainline(1, USER);
    expect(conflictPaths).toEqual([]);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins[0]).toMatchObject(
        { gadgetId: 1, baseCommit: e0, mergedCommit: c1 });
    expect(await gadgetContent(impl, 1, 1)).toEqual({
      "a.txt": "chat\n",
      "b.txt": "mainline\n",
    });

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

describe("agent change appends", () => {
  it("appendAgentCodeChange pins at the current head and mirrors the pin at append time",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    let ack = await impl.appendAgentCodeChange(1, AGENT,
        { 1: [["a.txt", { set: "one\nagent\n" }]] }, { gadgetId: 1, baseCommit: c1 });
    expect(ack).toEqual({ generation: 0, revision: 1 });
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toEqual(
        [{ gadgetId: 1, baseCommit: c1, mergedCommit: c1 }]);
    expect(await gadgetContent(impl, 1, 1)).toEqual({ "a.txt": "one\nagent\n" });
    expect(impl.listUnmaterializedChatChanges(1)).toHaveLength(1);
    expect(impl.undeclaredChatPins(1)).toEqual([{ gadgetId: 1, baseCommit: c1 }]);

    // The turn flush materializes the rows and declares the pin.
    expect(impl.flushAgentChanges(1, AGENT, {})).toBe(true);
    expect(impl.flushAgentChanges(1, AGENT, {})).toBe(false);  // nothing left
    let changes = chatMessages(impl, 1).filter(msg => msg.type === "changes");
    expect(changes).toHaveLength(1);
    expect(changes[0].author).toEqual(AGENT);
    expect(changes[0].pins).toEqual([{ gadgetId: 1, baseCommit: c1 }]);
    expect(impl.undeclaredChatPins(1)).toEqual([]);

    // A pin whose base is no longer the head fails the append (mid-turn head movement).
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1]);
    addGadget(impl, 2, "OTHER", c2);
    setHead(impl, 2, c1);
    await expect(impl.appendAgentCodeChange(1, AGENT,
        { 2: [["a.txt", { set: "x" }]] }, { gadgetId: 2, baseCommit: c2 }))
        .rejects.toThrow(/no longer the gadget's head/);
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
    for (let i = 1; i <= 129; i++) {
      let next = `${i}\n${text}`;
      await submit(impl, 1, {
        generation: 0, revision: i - 1, clientId: "cli", seq: i,
        ...(i === 1 ? { pins: [{ gadgetId: 1, baseCommit: c1 }] } : {}),
        change: editChange(1, { "a.txt": text }, { "a.txt": next }),
      });
      text = next;
    }

    // The 128-row window was materialized into a "changes" message; the stream keeps counting.
    let changes = chatMessages(impl, 1).filter(msg => msg.type === "changes");
    expect(changes).toHaveLength(1);
    expect(changes[0].watermark).toEqual({ changesGeneration: 0, throughRevision: 128 });
    expect(liveRows(impl, 1)).toHaveLength(1);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.revision).toBe(129);
    expect((await gadgetContent(impl, 1, 1))["a.txt"]).toBe(text);
  }));

  it("splits an oversized batch across consecutive watermarked messages",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    // Three rows setting *distinct* files (so their composition genuinely accumulates payload
    // rather than collapsing), each ~200K CJK characters = ~600KB of UTF-8 (hand-built `set`
    // changes: diffing dissimilar strings this large is quadratic). Any two rows compose past the
    // 1MB byte budget -- though a code-unit measure would put all three at ~600K "characters"
    // and pack them into one oversized message -- so materialization must cut per row.
    let files = ["a.txt", "b.txt", "c.txt"];
    let text = "文".repeat(200_000);
    for (let [i, file] of files.entries()) {
      await submit(impl, 1, {
        generation: 0, revision: i, clientId: "cli", seq: i + 1,
        ...(i === 0 ? { pins: [{ gadgetId: 1, baseCommit: c1 }] } : {}),
        change: { 1: [[file, { set: text }]] },
      });
    }

    impl.materializeChatChanges(1);
    let changes = chatMessages(impl, 1).filter(msg => msg.type === "changes");
    expect(changes).toHaveLength(3);
    // The pin declaration rides the first message only; each message's watermark names the
    // rows it absorbed.
    expect(changes[0].pins).toEqual([{ gadgetId: 1, baseCommit: c1 }]);
    expect(changes.map(msg => msg.watermark)).toEqual([
      { changesGeneration: 0, throughRevision: 1 },
      { changesGeneration: 0, throughRevision: 2 },
      { changesGeneration: 0, throughRevision: 3 },
    ]);
    expect(changes[1].pins).toBeUndefined();
    expect(liveRows(impl, 1)).toHaveLength(0);

    // The chunked log folds to the same content a single message would have.
    let folded = await impl.buildChatContent(1);
    expect(files.map(file => folded.get(1)!.get(file))).toEqual([text, text, text]);
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
