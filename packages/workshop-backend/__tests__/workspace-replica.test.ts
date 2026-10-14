import {describe, expect, it} from "vitest";
import {applyCodeChange, diffFiles, type FileChange} from "@gadgets/workshop-shared/code-change";
import {mergeReplicaBatch} from "../src/workspace-replica";
import {workspaceCollisionCases} from "./workspace-collision-cases";

async function merge(before: string | null, local: string | null, remote: string | undefined) {
  return mergeReplicaBatch(7, {
    batchId: "batch", files: [{path: "a.txt", before,
      change: diffFiles(content(before), content(local))[7]?.[0]?.[1] ?? null}],
  }, diffFiles(content(before), content(remote ?? null)));
}

function content(text: string | null) {
  return new Map([[7,
    text === null ? new Map<string, string>() : new Map([["a.txt", text]]),
  ]]);
}

describe("DO-authoritative replica reconciliation", () => {
  it.each(workspaceCollisionCases)("codifies $name against a common anchor", async collision => {
    let {change, ack} = await merge(collision.before, collision.shellText,
        collision.doText ?? undefined);
    expect(ack.accepted).toEqual([["a.txt", collision.expected]]);
    expect(applyCodeChange(content(collision.doText), change).get(7)?.get("a.txt") ?? null)
        .toBe(collision.expected);
    expect(applyCodeChange(content(collision.shellText), {7: ack.changes})
        .get(7)?.get("a.txt") ?? null).toBe(collision.expected);
    expect(applyCodeChange(content(collision.before), {7: ack.operations})
        .get(7)?.get("a.txt") ?? null).toBe(collision.expected);
  });

  it("transforms simultaneous independent edits and produces the same bytes at both ends", async () => {
    let {change, ack} = await merge("one\ntwo\n", "ONE\ntwo\n", "one\nTWO\n");
    expect(ack.accepted).toEqual([["a.txt", "ONE\nTWO\n"]]);
    expect(applyCodeChange(new Map([[7, new Map([["a.txt", "one\nTWO\n"]])]]), change)
        .get(7)?.get("a.txt")).toBe("ONE\nTWO\n");
    expect(applyCodeChange(new Map([[7, new Map([["a.txt", "ONE\ntwo\n"]])]]),
        {7: ack.changes}).get(7)?.get("a.txt")).toBe("ONE\nTWO\n");
  });

  it("preserves canonical insertion positions in repeated text instead of re-diffing", async () => {
    const {change, ack} = await mergeReplicaBatch(7, {batchId: "position", files: [
      {path: "a.txt", before: "aaa", change: {edit: [[0, "X"], 3]}},
    ]}, {7: [["a.txt", {edit: [[0, "a"], 3]}]]});
    expect(applyCodeChange(content("aaaa"), change).get(7)?.get("a.txt")).toBe("aXaaa");
    expect(applyCodeChange(content("Xaaa"), {7: ack.changes}).get(7)?.get("a.txt")).toBe("aXaaa");
  });

  it("does not echo DO-only edits back into the canonical stream", async () => {
    let {change, ack} = await merge("base\n", "base\n", "from DO\n");
    expect(change).toEqual({});
    expect(ack.changes).not.toEqual([]);
    expect(ack.operations).not.toEqual([]);
    expect(ack.accepted).toEqual([["a.txt", "from DO\n"]]);
  });

  it("accepts a tiny delta against text beyond the former file-size limit without expanding the OT", async () => {
    const before = "a".repeat(512 * 1024 + 1);
    const edit: FileChange = {edit: [before.length, [0, "!"]]};
    const {change, ack} = await mergeReplicaBatch(7, {batchId: "large-anchor", files: [
      {path: "a.txt", before, change: edit},
    ]}, {});
    expect(change).toEqual({7: [["a.txt", edit]]});
    expect(ack.operations).toEqual([["a.txt", edit]]);
    expect(ack.accepted[0][1]?.length).toBe(before.length + 1);
    expect(ack.accepted[0][1]?.endsWith("!")).toBe(true);
  });

  it("accepts new container files without requiring git add", async () => {
    let {change, ack} = await merge(null, "new\n", undefined);
    expect(change).toEqual({7: [["a.txt", {set: "new\n"}]]});
    expect(ack.changes).toEqual([]);
    expect(ack.accepted).toEqual([["a.txt", "new\n"]]);
  });

  it("accepts a deletion and catches up an unchanged replica to a DO deletion", async () => {
    expect((await merge("base", null, "base")).change)
        .toEqual({7: [["a.txt", {remove: true}]]});
    let {change, ack} = await merge("base", "base", undefined);
    expect(change).toEqual({});
    expect(ack.changes).toEqual([["a.txt", {remove: true}]]);
  });

  it("uses existing last-accepted priority for same-path creations, not replica clocks", async () => {
    expect((await merge(null, "container", "DO")).ack.accepted)
        .toEqual([["a.txt", "container"]]);
  });

  it("preserves astral Unicode through the CodeMirror UTF-16 OT representation", async () => {
    let {ack} = await merge("😀\nend\n", "😀!\nend\n", "😀\nEND\n");
    expect(ack.accepted).toEqual([["a.txt", "😀!\nEND\n"]]);
  });

  it("rejects duplicate and private paths before accepting mutations", async () => {
    await expect(mergeReplicaBatch(7, {batchId: "bad", files: [
      {path: "a", before: null, change: {set: "x"}}, {path: "a", before: null, change: {set: "y"}},
    ]}, {})).rejects.toThrow("Duplicate");
    await expect(mergeReplicaBatch(7, {batchId: "bad", files: [
      {path: "../escape", before: null, change: {set: "x"}},
    ]}, {})).rejects.toThrow();
    await expect(mergeReplicaBatch(7, {batchId: "bad", files: [
      {path: ".git/config", before: null, change: {set: "x"}},
    ]}, {})).rejects.toThrow();
  });
});
