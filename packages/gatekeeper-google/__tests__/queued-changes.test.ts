import { describe, expect, it } from "vitest";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { checkQueuedSize, MAX_CHANGE_BYTES, QueuedChanges } from "../src/queued-changes";
import { FakeKv } from "./fake-kv";

/** A record of one journal shared by two files, as a Drive connection keeps them. */
type Edit = { file: string; text: string };

function journal(): ActionJournal<Edit> {
  return new ActionJournal<Edit>(new FakeKv(), { namespace: "test" });
}

/** One file's changes in `edits`, with the wording a Drive connection gives the order rule. */
function changesOf(edits: ActionJournal<Edit>, file: string): QueuedChanges<Edit, string> {
  return new QueuedChanges<Edit, string>({
    journal: edits,
    select: edit => edit.file === file ? edit.text : undefined,
    outOfOrder: earlier => `Decide change ${earlier} first.`,
  });
}

/** Queues `text` on `file` through `changes`, as a session's change queue does. */
function queue(
  edits: ActionJournal<Edit>, changes: QueuedChanges<Edit, string>, file: string, text: string,
): Promise<number> {
  let id = 0;
  return changes.queue(async () => ({ payload: text, result: undefined }), async payload => {
    id = edits.allocate({ file, text: payload });
    edits.markSubmitted(id);
  }).then(() => id);
}

describe("QueuedChanges", () => {
  it("refuses a change too large to store, before it is submitted", async () => {
    let edits = journal();
    let changes = changesOf(edits, "a");
    let submitted = false;
    let text = "x".repeat(MAX_CHANGE_BYTES / 2);
    await expect(changes.queue(async () => ({ payload: text, result: undefined }), async () => {
      submitted = true;
    })).rejects.toThrow(
      `This change is too large to queue (${(text.length + 2) * 2} bytes, limit ${
        MAX_CHANGE_BYTES}). Split it up.`);
    expect(submitted).toBe(false);
    // The limit is the connection's to choose.
    expect(() => checkQueuedSize("abc", 8)).toThrow("(10 bytes, limit 8)");
  });

  it("keeps each file's view, order and restart answer apart within one journal", async () => {
    let edits = journal();
    let a = changesOf(edits, "a");
    let b = changesOf(edits, "b");
    let a1 = await queue(edits, a, "a", "one");
    // Another kind of write, numbered by the same counter between them.
    let comment = edits.allocate({ file: "comment", text: "note" });
    edits.markSubmitted(comment);
    let b1 = await queue(edits, b, "b", "two");
    let a2 = await queue(edits, a, "a", "three");
    expect([a1, comment, b1, a2]).toEqual([1, 2, 3, 4]);

    expect(await a.snapshot(async pending => pending)).toEqual([
      { id: a1, action: "one" }, { id: a2, action: "three" },
    ]);
    expect(await b.snapshot(async pending => pending)).toEqual([{ id: b1, action: "two" }]);

    // The other file's change waits before it, and does not hold it back.
    let applied: number[] = [];
    await b.apply(b1, async () => { applied.push(b1); edits.retire(b1); });
    await expect(a.apply(a2, async () => { applied.push(a2); })).rejects.toThrow(
      `Decide change ${a1} first.`);
    expect(applied).toEqual([b1]);

    // Rejecting a's first change undoes what its second was built on; b has nothing behind it.
    expect(await a.reject(a1, async () => edits.remove(a1))).toEqual({ restart: true });
    expect(await a.reject(a2, async () => edits.remove(a2))).toBeUndefined();
  });

  it("prepares changes one at a time, in the order they were sent", async () => {
    let edits = journal();
    let changes = changesOf(edits, "a");
    let release!: () => void;
    let held = new Promise<void>(resolve => { release = resolve; });
    let order: string[] = [];
    let first = changes.queue(async () => {
      await held;
      order.push("first prepared");
      return { payload: "first", result: undefined };
    }, async () => { order.push("first submitted"); });
    let second = changes.queue(async () => {
      order.push("second prepared");
      return { payload: "second", result: undefined };
    }, async () => { order.push("second submitted"); });
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(
      ["first prepared", "first submitted", "second prepared", "second submitted"]);
  });
});
